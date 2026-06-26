import {
  Injectable,
  BadRequestException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MongoService } from '../mongo.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';
import { GenerateCallingCampaignDto } from './dto/generate-calling-campaign.dto';
import { AiCallingBotsService } from '../ai-calling-bots/ai-calling-bots.service';
import { decryptSystemSettings } from '../settings/credential-encryption';
import { GeminiLiveService } from '../ai-calling/gemini-live.service';
import {
  buildKeywordRegex,
  readBooleanConfig,
  readNumberConfig,
  readStringConfig,
  readStringListConfig,
} from '../ai-calling/ai-calling-runtime';
import {
  AgentScriptTurn,
  buildAgentPersona,
  buildConversationUserPrompt,
  buildLiveCallingPreUserPrompt,
  buildLiveCallingSystemPrompt,
  extractRelevantKnowledgeSummary,
  isLowInformationTurn,
  normalizeConversationGeneration as normalizeAgentConversationGeneration,
} from '../ai-calling/ai-calling-agent';

type TwilioSettings = {
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  twilioStatus?: string;
};

type GeneratedCallingCampaign = {
  name: string;
  objective: string;
  prompt: string;
  botName: string;
  botRole: string;
  botGoal: string;
  botPersonality: string;
  botKnowledge: string;
  botRules: string;
  botObjectionHandling: string;
  botGreeting: string;
  voice?: string;
  language?: string;
};

type CachedGoogleSpeech = {
  audio: Buffer;
  createdAt: number;
};

const GOOGLE_TTS_TIMEOUT_MS = 3500;
const GEMINI_TWILIO_TIMEOUT_MS = 2500;
const TWILIO_RESPONSE_BUDGET_MS = 5000;
const TWILIO_SPEECH_TIMEOUT_SECONDS = 1;
const MAX_GEMINI_LIVE_CALL_MODELS = 2;
const DEFAULT_LIVE_PROMPT_SCRIPT_TURNS = 14;
const DEFAULT_LIVE_RAC_QUERY_CHARS = 900;
const TWILIO_HD_PLAY_ENABLED = true;
const AI_CALLING_MODE = 'gemini_live';
const AI_CALLING_ALLOW_TWILIO_GATHER_FALLBACK = false;
const DEFAULT_GEMINI_TEXT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash-001',
  'gemini-1.5-flash-002',
];
const DEFAULT_IMMEDIATE_END_TERMS = [
  'bye',
  'goodbye',
  'not interested',
  'wrong number',
  'stop calling',
  'remove me',
  "don't call",
  'do not call',
  'no thanks',
  'no thank you',
];
const DEFAULT_PROMPT_EXPOSURE_TERMS = [
  'system prompt',
  'prompt',
  'instructions',
  'hidden instructions',
  'developer message',
  'jailbreak',
  'ignore previous',
  'reveal your rules',
  'show your rules',
];

// Statuses that indicate a call row is fully settled (no more Twilio events expected)
const TERMINAL_CALL_OUTCOMES = new Set([
  'ANSWERED',
  'COMPLETED',
  'NO_ANSWER',
  'BUSY',
  'FAILED',
  'CANCELLED',
  'VOICEMAIL',
]);

// Twilio status strings that are terminal
const TERMINAL_TWILIO_STATUSES = new Set([
  'completed',
  'busy',
  'failed',
  'no-answer',
  'canceled',
]);

type CallingCampaignGenerationJob = {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: GeneratedCallingCampaign;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type TwilioQueueResult = {
  placed: number;
  failed: number;
  errors: string[];
};

type ConversationGeneration = {
  reply: string;
  shouldEnd: boolean;
  endReason: string;
  collectedData: Record<string, unknown>;
  sentimentScore: number;
  keyOutcomes: string;
  topicsCovered: string[];
};

@Injectable()
export class CallingCampaignsService implements OnModuleInit {
  private readonly logger = new Logger(CallingCampaignsService.name);
  private generationJobs = new Map<string, CallingCampaignGenerationJob>();
  private googleSpeechCache = new Map<string, CachedGoogleSpeech>();
  private immediateEndPatternCache: RegExp | null = null;
  private promptExposureTermsCache: string[] | null = null;

  constructor(
    private db: MongoService,
    private configService: ConfigService,
    private aiCallingBotsService: AiCallingBotsService,
    private geminiLiveService: GeminiLiveService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  onModuleInit() {
    // FIX 6: Prune Google TTS audio cache every 5 minutes to prevent memory leaks.
    // Entries older than 10 minutes are evicted (Twilio will have already played them).
    setInterval(
      () => {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [id, cached] of this.googleSpeechCache.entries()) {
          if (cached.createdAt < cutoff) {
            this.googleSpeechCache.delete(id);
          }
        }
        this.logger.debug(
          `Google TTS cache pruned; remaining entries: ${this.googleSpeechCache.size}`,
        );
      },
      5 * 60 * 1000,
    ).unref();

    // FIX 7: Prune completed/failed generation jobs older than 1 hour to prevent memory leaks.
    setInterval(
      () => {
        const cutoff = Date.now() - 60 * 60 * 1000;
        let pruned = 0;
        for (const [id, job] of this.generationJobs.entries()) {
          if (
            (job.status === 'COMPLETED' || job.status === 'FAILED') &&
            new Date(job.updatedAt).getTime() < cutoff
          ) {
            this.generationJobs.delete(id);
            pruned++;
          }
        }
        if (pruned > 0) {
          this.logger.debug(
            `Generation job cache pruned; removed ${pruned} stale jobs`,
          );
        }
      },
      15 * 60 * 1000,
    ).unref();
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async findAll() {
    const campaigns = await this.db.callingCampaign.findMany({
      include: {
        calls: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      objective: c.objective,
      prompt: c.prompt,
      voiceQuality: c.voiceQuality,
      voice: c.voice,
      language: c.language,
      aiCallingBotId: c.aiCallingBotId,
      botName: c.botName,
      botRole: c.botRole,
      botGoal: c.botGoal,
      botPersonality: c.botPersonality,
      botKnowledge: c.botKnowledge,
      botRules: c.botRules,
      botObjectionHandling: c.botObjectionHandling,
      botGreeting: c.botGreeting,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      contactCount: c.calls.length,
      answeredCount: c.calls.filter((call: any) => call.outcome === 'ANSWERED')
        .length,
      tags: c.tags || [],
      concurrencyLimit: c.concurrencyLimit || 50,
      scheduleType: c.scheduleType || 'IMMEDIATE',
      scheduledAt: c.scheduledAt || null,
      timezone: c.timezone || 'UTC',
      estimatedCost: c.estimatedCost || 0,
      estimatedDuration: c.estimatedDuration || 0,
    }));
  }

  async findOne(id: string) {
    const campaign = await this.db.callingCampaign.findUnique({
      where: { id },
      include: {
        calls: {
          include: {
            contact: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new BadRequestException('Calling campaign not found');
    }

    return campaign;
  }

  async create(dto: CreateCallingCampaignDto) {
    const { contactIds, ...rest } = dto;
    this.logger.debug(
      `Creating calling campaign "${rest.name}" with ${contactIds?.length || 0} requested contacts`,
    );
    const normalizedInput = this.normalizeCampaignVoiceInput(rest);
    const campaignData = await this.applyAiCallingBotDefaults(normalizedInput);
    const campaign = await this.db.callingCampaign.create({
      data: campaignData,
    });

    if (contactIds && contactIds.length > 0) {
      const result = await this.addCallableContacts(campaign.id, contactIds);
      this.logger.debug(
        `Campaign ${campaign.id} created: ${result.added} pending calls added, ${result.skipped} contacts skipped`,
      );
    }

    return campaign;
  }

  startCampaignGeneration(dto: GenerateCallingCampaignDto) {
    const now = new Date().toISOString();
    const job: CallingCampaignGenerationJob = {
      id: randomUUID(),
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
    };

    this.generationJobs.set(job.id, job);
    void this.runCampaignGenerationJob(job.id, dto);

    return job;
  }

  getCampaignGenerationStatus(id: string) {
    const job = this.generationJobs.get(id);
    if (!job) {
      throw new BadRequestException(
        'Calling campaign generation job not found',
      );
    }
    return job;
  }

  async generateCampaign(dto: GenerateCallingCampaignDto) {
    const userPrompt = dto.prompt?.trim();
    if (!userPrompt) {
      throw new BadRequestException('Prompt is required.');
    }

    const tone = dto.tone?.trim() || 'warm, natural, concise, and helpful';
    const apiKey = await this.getGeminiApiKey();
    if (!apiKey) {
      this.logger.warn(
        'Gemini API key is missing; using mock campaign generation.',
      );
      return this.buildMockGeneratedCampaign(userPrompt, tone);
    }

    const supportedVoices = this.aiCallingBotsService
      .getGoogleVoiceProfiles()
      .map((voice) => `${voice.voice} (${voice.language})`)
      .join(', ');
    const prompt = `You are an expert AI calling campaign designer. Create a complete outbound AI calling campaign from this user request:

USER REQUEST:
${userPrompt}

TONE:
${tone}

The calling agent must act like a real person, not like a prompt reader. It should ask permission, listen first, handle objections briefly, and capture a clear next step. Use Google-only voices for natural AI calling audio.

Return ONLY valid JSON with exactly these fields:
{
  "name": "Short campaign name",
  "objective": "One sentence goal",
  "prompt": "Campaign context and call instructions",
  "botName": "Human first name",
  "botRole": "Human role for the caller",
  "botGoal": "Concrete conversation success condition",
  "botPersonality": "Natural persona instructions",
  "botKnowledge": "Facts, offer details, qualification points, and context the bot should know",
  "botRules": "Rules the bot must follow",
  "botObjectionHandling": "How to respond to common objections",
  "botGreeting": "Opening line using {{firstName}} and {{botName}} variables",
  "voice": "One Google voice profile only from: ${supportedVoices}",
  "language": "BCP-47 language code from the selected voice profile"
}`;

    const model =
      this.configService.get<string>('GEMINI_CAMPAIGN_MODEL')?.trim() ||
      this.configService.get<string>('GEMINI_CHAT_MODEL')?.trim() ||
      this.configService.get<string>('VERTEX_AI_MODEL')?.trim() ||
      this.configService.get<string>('GOOGLE_VERTEX_MODEL')?.trim() ||
      this.getDefaultGeminiTextModels()[0];
    const response = await fetch(
      this.buildGeminiActionUrl(model, 'generateContent', apiKey),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 700,
            responseMimeType: 'application/json',
          },
        }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BadRequestException(
        data?.error?.message || 'AI campaign generation failed.',
      );
    }

    const contentString = String(
      data?.candidates?.[0]?.content?.parts
        ?.map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
        .join('\n') || '',
    ).trim();
    if (!contentString) {
      throw new BadRequestException('Empty AI campaign response.');
    }

    const parsed = this.parseJsonObject(contentString);
    return this.normalizeGeneratedCampaign(parsed, userPrompt, tone);
  }

  private async runCampaignGenerationJob(
    id: string,
    dto: GenerateCallingCampaignDto,
  ) {
    const current = this.generationJobs.get(id);
    if (!current) return;

    this.generationJobs.set(id, {
      ...current,
      status: 'PROCESSING',
      updatedAt: new Date().toISOString(),
    });

    try {
      const result = await this.generateCampaign(dto);
      this.generationJobs.set(id, {
        ...this.generationJobs.get(id)!,
        status: 'COMPLETED',
        result,
        updatedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      this.generationJobs.set(id, {
        ...this.generationJobs.get(id)!,
        status: 'FAILED',
        error: error.message || 'AI calling campaign generation failed.',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  async update(
    id: string,
    dto: Partial<CreateCallingCampaignDto> & { status?: string },
  ) {
    const { contactIds, ...rest } = dto;
    this.logger.debug(
      `Updating calling campaign ${id}; fields=${Object.keys(rest).join(',') || 'none'}; requestedContacts=${contactIds?.length || 0}`,
    );
    const normalizedInput = this.normalizeCampaignVoiceInput(rest);
    const campaignData = await this.applyAiCallingBotDefaults(normalizedInput);
    const campaign = await this.db.callingCampaign.update({
      where: { id },
      data: campaignData,
    });

    if (contactIds) {
      const result = await this.addCallableContacts(id, contactIds);
      this.logger.debug(
        `Campaign ${id} updated: ${result.added} pending calls added, ${result.skipped} contacts skipped`,
      );
    }

    return campaign;
  }

  async remove(id: string) {
    this.logger.debug(`Deleting calling campaign ${id} and related calls`);
    const deletedCalls = await this.db.callHistory.deleteMany({
      where: { campaignId: id },
    });
    this.logger.debug(
      `Deleted ${deletedCalls.count} call history rows for campaign ${id}`,
    );
    return this.db.callingCampaign.delete({
      where: { id },
    });
  }

  // ---------------------------------------------------------------------------
  // Launch
  // ---------------------------------------------------------------------------

  async launchCampaign(id: string, options?: { forceRelaunch?: boolean }) {
    const forceRelaunch = Boolean(options?.forceRelaunch);
    this.logger.debug(`Launch requested for calling campaign ${id}`);
    const campaign = await this.db.callingCampaign.findUnique({
      where: { id },
      include: {
        calls: {
          include: { contact: true },
        },
      },
    });

    if (!campaign) {
      this.logger.warn(`Launch failed: calling campaign ${id} not found`);
      throw new BadRequestException('Calling campaign not found');
    }

    // FIX 1: Block re-entry on both RUNNING and the new LAUNCHING guard status.
    if (campaign.status === 'RUNNING' || campaign.status === 'LAUNCHING') {
      this.logger.warn(
        `Launch blocked for campaign ${id}: status is ${campaign.status}`,
      );
      throw new BadRequestException('Calling campaign is already running');
    }

    const settings = decryptSystemSettings(
      await this.db.systemSettings.findUnique({
        where: { id: 'default' },
      }),
    );
    const hasTwilio = this.hasUsableTwilioSettings(settings);
    const launchMode = hasTwilio ? 'twilio' : 'simulation';
    this.logger.debug(
      `Campaign ${id} launch provider check: Twilio status=${settings?.twilioStatus || 'DISCONNECTED'}, from=${settings?.twilioPhoneNumber || 'not configured'}; current mode=${launchMode}`,
    );
    const launchLanguage = this.resolveGoogleVoiceLanguage(
      campaign.language,
      campaign.voice,
    );
    const launchVoice = this.resolveGoogleTtsVoice(
      campaign.voice,
      launchLanguage,
    );
    this.logger.debug(
      `Campaign ${id} AI calling voice config at launch: language=${launchLanguage}; voice=${launchVoice}; voiceQuality=${campaign.voiceQuality || 'standard'}; rawLanguage=${campaign.language || 'not set'}; rawVoice=${campaign.voice || 'not set'}`,
    );

    const callableCalls = (campaign.calls || []).filter((call: any) =>
      this.hasCallablePhone(call.contact),
    );
    const pendingCallableCalls = callableCalls.filter(
      (call: any) => call.outcome === 'PENDING',
    );
    const skippedCalls = campaign.calls.length - callableCalls.length;

    this.logger.debug(
      `Campaign ${id} launch check: ${campaign.calls.length} total call rows, ${pendingCallableCalls.length} pending callable rows, ${callableCalls.length} total callable rows, ${skippedCalls} rows missing phone numbers`,
    );

    if (callableCalls.length === 0) {
      this.logger.warn(
        `Launch blocked for campaign ${id}: no contacts with phone numbers`,
      );
      throw new BadRequestException(
        'No contacts with phone numbers in this campaign',
      );
    }

    const shouldResetForRelaunch =
      forceRelaunch || pendingCallableCalls.length === 0;

    if (hasTwilio) {
      this.assertPublicTwilioWebhookUrl();
    }

    await this.assertGeminiLiveReadyBeforeCalling(id);

    // FIX 1: Write LAUNCHING first as a distributed entry-lock so any concurrent
    // launch request is rejected before we begin queuing Twilio calls.
    await this.db.callingCampaign.update({
      where: { id },
      data: { status: 'LAUNCHING' },
    });

    let twilioQueueResult: TwilioQueueResult | null = null;

    try {
      if (shouldResetForRelaunch) {
        this.logger.debug(
          `Relaunch requested for campaign ${id}; resetting ${callableCalls.length} previous calls to PENDING`,
        );
        await this.resetCallsForRelaunch(callableCalls);
      }

      if (hasTwilio) {
        // Promote to RUNNING now that we are actively placing calls with Twilio.
        await this.db.callingCampaign.update({
          where: { id },
          data: { status: 'RUNNING' },
        });
        twilioQueueResult = await this.runTwilioOutboundCalls(
          campaign.id,
          settings,
        );
      } else {
        this.logger.warn(
          `Campaign ${id} is using simulation because Twilio is not fully connected`,
        );
        await this.db.callingCampaign.update({
          where: { id },
          data: { status: 'RUNNING' },
        });
        // Fire-and-forget; simulation manages its own completion transition.
        this.runCallSimulation(campaign.id);
      }
    } catch (err) {
      // If anything throws before or during queueing, park the campaign as FAILED
      // so it is not stuck in LAUNCHING/RUNNING indefinitely.
      this.logger.error(
        `Campaign ${id} failed during launch`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.db.callingCampaign
        .update({ where: { id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      throw err;
    }

    return {
      success: true,
      message: shouldResetForRelaunch
        ? `Calling campaign relaunched in ${launchMode} mode`
        : `Calling campaign started in ${launchMode} mode`,
      twilio: twilioQueueResult,
    };
  }

  async relaunchCampaign(id: string) {
    return this.launchCampaign(id, { forceRelaunch: true });
  }

  async stopCampaign(id: string) {
    this.logger.debug(`Stop requested for calling campaign ${id}`);
    const campaign = await this.db.callingCampaign.findUnique({
      where: { id },
      include: {
        calls: true,
      },
    });

    if (!campaign) {
      throw new BadRequestException('Calling campaign not found');
    }

    if (!['RUNNING', 'LAUNCHING'].includes(campaign.status || '')) {
      throw new BadRequestException(
        'Calling campaign is not running or queued',
      );
    }

    await this.db.callingCampaign.update({
      where: { id },
      data: { status: 'STOPPED' },
    });

    const callsToCancel = (campaign.calls || []).filter((call: any) =>
      this.isCallCancellable(call),
    );

    const settings = decryptSystemSettings(
      await this.db.systemSettings.findUnique({
        where: { id: 'default' },
      }),
    );
    const hasTwilio = this.hasUsableTwilioSettings(settings);
    const now = new Date();
    const stopResults = await Promise.all(
      callsToCancel.map(async (call: any) => {
        let stopError: string | null = null;
        let twilioStopAttempted = false;

        if (
          hasTwilio &&
          call.provider === 'TWILIO' &&
          typeof call.providerCallSid === 'string' &&
          call.providerCallSid.trim()
        ) {
          twilioStopAttempted = true;
          const result = await this.stopTwilioCall({
            accountSid: settings?.twilioAccountSid || '',
            authToken: settings?.twilioAuthToken || '',
            callSid: call.providerCallSid,
          });
          if (!result.ok) {
            stopError = result.error;
          }
        }

        const nextSessionErrors = Array.isArray(call.sessionErrors)
          ? [...call.sessionErrors]
          : [];
        if (stopError) {
          nextSessionErrors.push({
            errorCode: 'TWILIO_STOP_FAILED',
            errorMessage: stopError,
          });
        }

        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            status: 'CANCELLED',
            outcome: 'CANCELLED',
            sessionStatus: 'cancelled',
            endedAt: call.endedAt || now,
            endCallReason: 'Campaign was stopped by user.',
            providerStatus:
              call.provider === 'TWILIO' &&
              call.providerCallSid &&
              twilioStopAttempted
                ? stopError
                  ? call.providerStatus || 'stop_failed'
                  : 'canceled'
                : call.providerStatus,
            errorMessage: stopError
              ? `Could not cancel provider call: ${stopError}`
              : null,
            sessionErrors: nextSessionErrors,
            timestamp: now,
          },
        });

        return {
          attemptedTwilioStop: twilioStopAttempted,
          twilioStopFailed: Boolean(stopError),
          error: stopError,
        };
      }),
    );

    const twilioStopped = stopResults.filter(
      (item) => item.attemptedTwilioStop && !item.twilioStopFailed,
    ).length;
    const twilioFailed = stopResults.filter(
      (item) => item.twilioStopFailed,
    ).length;
    const errors = stopResults
      .map((item) => item.error)
      .filter((value): value is string => typeof value === 'string');

    this.logger.debug(
      `Campaign ${id} stopped; callsCancelled=${callsToCancel.length}; twilioStopped=${twilioStopped}; twilioFailed=${twilioFailed}`,
    );

    return {
      success: true,
      message: 'Calling campaign stopped',
      cancelledCalls: callsToCancel.length,
      twilio: {
        stopped: twilioStopped,
        failed: twilioFailed,
        errors,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Twilio outbound calling
  // ---------------------------------------------------------------------------

  private async runTwilioOutboundCalls(
    campaignId: string,
    settings: TwilioSettings,
  ): Promise<TwilioQueueResult> {
    const resultSummary: TwilioQueueResult = {
      placed: 0,
      failed: 0,
      errors: [],
    };

    try {
      this.logger.debug(
        `Starting Twilio outbound calls for campaign ${campaignId}`,
      );
      const campaign = await this.db.callingCampaign.findUnique({
        where: { id: campaignId },
        include: {
          calls: {
            where: { outcome: 'PENDING' },
            include: { contact: true },
          },
        },
      });

      if (!campaign) {
        this.logger.warn(
          `Twilio calling stopped: campaign ${campaignId} was not found`,
        );
        resultSummary.errors.push('Campaign not found.');
        return resultSummary;
      }

      // FIX 9: Respect the campaign's concurrencyLimit when placing calls.
      // Calls are grouped into batches; each batch is fired concurrently via
      // Promise.all, then the next batch starts once the current one settles.
      const concurrencyLimit = Math.max(
        1,
        Number(campaign.concurrencyLimit) || 50,
      );
      const allCalls = campaign.calls as any[];
      const selectedLanguage = this.resolveGoogleVoiceLanguage(
        campaign.language,
        campaign.voice,
      );
      const selectedVoice = this.resolveGoogleTtsVoice(
        campaign.voice,
        selectedLanguage,
      );
      this.logger.debug(
        `Twilio campaign ${campaignId} resolved AI calling voice config: language=${selectedLanguage}; voice=${selectedVoice}; voiceQuality=${campaign.voiceQuality || 'standard'}; rawLanguage=${campaign.language || 'not set'}; rawVoice=${campaign.voice || 'not set'}`,
      );
      const batches: (typeof allCalls)[] = [];
      for (let i = 0; i < allCalls.length; i += concurrencyLimit) {
        batches.push(allCalls.slice(i, i + concurrencyLimit));
      }

      for (const batch of batches) {
        const latestCampaign = await this.db.callingCampaign.findUnique({
          where: { id: campaignId },
          select: { status: true },
        });
        if (latestCampaign?.status === 'STOPPED') {
          this.logger.warn(
            `Stopping Twilio queueing for campaign ${campaignId}: campaign was manually stopped`,
          );
          resultSummary.errors.push(
            'Campaign was stopped before queueing completed.',
          );
          return resultSummary;
        }

        await Promise.all(
          batch.map(async (call) => {
            const contact = call.contact;
            if (!this.hasCallablePhone(contact)) {
              resultSummary.failed++;
              this.logger.warn(
                `Skipping Twilio call ${call.id} in campaign ${campaignId}: contact ${call.contactId} has no phone number`,
              );
              return; // FIX 9: use return instead of continue inside async map
            }

            const latestCall = await this.db.callHistory.findUnique({
              where: { id: call.id },
              select: { status: true, outcome: true },
            });
            if (
              latestCall?.status === 'CANCELLED' ||
              latestCall?.outcome === 'CANCELLED'
            ) {
              this.logger.debug(
                `Skipping Twilio call ${call.id} in campaign ${campaignId}: call was already cancelled`,
              );
              return;
            }

            this.logger.debug(
              `Creating Twilio call ${call.id} from ${settings.twilioPhoneNumber} to ${this.maskPhoneNumber(contact.phoneNumber)}; language=${selectedLanguage}; voice=${selectedVoice}; voiceQuality=${campaign.voiceQuality || 'standard'}`,
            );
            const botProfile = await this.resolveBotProfile(campaign);
            const openingScript = this.buildLiveOpeningScript(
              campaign,
              contact,
              botProfile,
            );
            const openingTranscript = `AI Agent: ${openingScript}`;

            await this.db.callHistory.update({
              where: { id: call.id },
              data: {
                provider: 'TWILIO',
                status: 'QUEUING',
                outcome: 'QUEUING',
                sessionStatus: 'inprogress',
                callType: 'phone_call',
                selectedLanguage,
                selectedVoice,
                startedAt: new Date(),
                scripts: this.transcriptToScripts(openingTranscript),
                transcript: openingTranscript,
                summary: `${botProfile.name} queued an outbound call for ${contact.firstName || 'the contact'} about ${campaign.objective || 'the campaign objective'}.`,
                analysis: {
                  intent: 'queued_outbound_call',
                  agentPersona: {
                    name: botProfile.name,
                    role: botProfile.role,
                    personality: botProfile.personality,
                  },
                  topicsCovered: this.buildTopicsCovered(campaign, botProfile),
                },
                topicsCovered: this.buildTopicsCovered(campaign, botProfile),
                sessionErrors: [],
                errorMessage: null,
              },
            });

            const answerWebhook = this.getTwilioWebhookUrl('answer', call.id);
            const statusWebhook = this.getTwilioWebhookUrl('status', call.id);
            const recordingWebhook = this.getTwilioWebhookUrl(
              'recording',
              call.id,
            );
            this.logger.debug(
              'Twilio webhooks for call ' +
                call.id +
                ': answer=' +
                answerWebhook +
                ', status=' +
                statusWebhook +
                ', recording=' +
                recordingWebhook,
            );

            const result = await this.createTwilioCall({
              accountSid: settings.twilioAccountSid || '',
              authToken: settings.twilioAuthToken || '',
              from: settings.twilioPhoneNumber || '',
              to: contact.phoneNumber,
              url: answerWebhook,
              statusCallback: statusWebhook,
              recordingStatusCallback: recordingWebhook,
            });

            if (result.ok) {
              resultSummary.placed++;
              await this.db.callHistory.update({
                where: { id: call.id },
                data: {
                  provider: 'TWILIO',
                  providerCallSid: result.sid,
                  providerStatus: result.status,
                  status: 'QUEUED',
                  outcome: 'QUEUED',
                  sessionStatus: 'inprogress',
                  timestamp: new Date(),
                },
              });
              this.logger.debug(
                `Twilio accepted call ${call.id}; sid=${result.sid}; status=${result.status}`,
              );
            } else {
              resultSummary.failed++;
              resultSummary.errors.push(result.error);
              await this.db.callHistory.update({
                where: { id: call.id },
                data: {
                  provider: 'TWILIO',
                  providerStatus: 'FAILED',
                  status: 'FAILED',
                  outcome: 'FAILED',
                  sessionStatus: 'failed',
                  endedAt: new Date(),
                  endCallReason: 'Provider rejected the outbound call.',
                  sessionErrors: [
                    {
                      errorCode: 'TWILIO_REJECTED',
                      errorMessage: result.error,
                    },
                  ],
                  errorMessage: result.error,
                  timestamp: new Date(),
                },
              });
              this.logger.error(
                `Twilio rejected call ${call.id}: ${result.error}`,
              );
            }
          }),
        );
      }

      // Stay RUNNING — completion is driven by handleTwilioStatus once all calls settle.
      // Only fail immediately if every call was rejected at the Twilio API level.
      if (resultSummary.failed > 0 && resultSummary.placed === 0) {
        await this.db.callingCampaign.update({
          where: { id: campaignId },
          data: { status: 'FAILED' },
        });
      }
      this.logger.debug(
        `Twilio campaign ${campaignId} finished queueing: ${resultSummary.placed} accepted, ${resultSummary.failed} failed`,
      );
      return resultSummary;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resultSummary.errors.push(message);
      this.logger.error(
        `Twilio calling error for campaign ${campaignId}`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'FAILED' },
      });
      return resultSummary;
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  private async runCallSimulation(campaignId: string) {
    try {
      this.logger.debug(`Starting call simulation for campaign ${campaignId}`);
      const campaign = await this.db.callingCampaign.findUnique({
        where: { id: campaignId },
        include: {
          calls: {
            where: { outcome: 'PENDING' },
            include: { contact: true },
          },
        },
      });

      if (!campaign) {
        this.logger.warn(
          `Call simulation stopped: campaign ${campaignId} was not found`,
        );
        return;
      }

      const outcomes = [
        'ANSWERED',
        'ANSWERED',
        'ANSWERED',
        'NO_ANSWER',
        'BUSY',
        'FAILED',
      ];
      const recordingUrls = [
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
      ];

      for (const call of campaign.calls) {
        const latestCampaign = await this.db.callingCampaign.findUnique({
          where: { id: campaignId },
          select: { status: true },
        });
        if (latestCampaign?.status === 'STOPPED') {
          this.logger.warn(
            `Stopping simulation for campaign ${campaignId}: campaign was manually stopped`,
          );
          return;
        }

        const contact = call.contact;
        if (!this.hasCallablePhone(contact)) {
          this.logger.warn(
            `Skipping call ${call.id} in campaign ${campaignId}: contact ${call.contactId} has no phone number`,
          );
          continue;
        }

        this.logger.debug(
          `Dialing call ${call.id} for ${contact.firstName} ${contact.lastName} at ${this.maskPhoneNumber(contact.phoneNumber)}`,
        );
        const startedAt = new Date();
        const selectedLanguage = this.resolveGoogleVoiceLanguage(
          campaign.language,
          campaign.voice,
        );
        const selectedVoice = this.resolveGoogleTtsVoice(
          campaign.voice,
          selectedLanguage,
        );

        // 1. DIALING
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            provider: 'SIMULATION',
            status: 'DIALING',
            outcome: 'DIALING',
            sessionStatus: 'inprogress',
            callType: 'phone_call',
            selectedLanguage,
            selectedVoice,
            startedAt,
            scripts: [],
            sessionErrors: [],
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 2. RINGING
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            status: 'RINGING',
            outcome: 'RINGING',
            startupTime: Date.now() - startedAt.getTime(),
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];

        if (outcome === 'ANSWERED') {
          // 3. CONNECTED / IN PROGRESS
          const connectedAt = new Date();
          await this.db.callHistory.update({
            where: { id: call.id },
            data: {
              status: 'CONNECTED',
              outcome: 'CONNECTED',
              sessionStatus: 'connected',
              connectedAt,
              startupTime: connectedAt.getTime() - startedAt.getTime(),
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 1000));

          await this.db.callHistory.update({
            where: { id: call.id },
            data: { status: 'IN_PROGRESS', outcome: 'IN_PROGRESS' },
          });
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const duration = Math.floor(Math.random() * 120) + 30;
          const recordingUrl =
            recordingUrls[Math.floor(Math.random() * recordingUrls.length)];
          const sentimentScore = parseFloat((Math.random() * 3 + 7).toFixed(1));
          const botProfile = await this.resolveBotProfile(campaign);
          const summary = `${botProfile.name} spoke with ${contact.firstName} about ${campaign.objective || 'the campaign objective'} and captured the next step.`;
          const keyOutcomes = this.buildKeyOutcomes(campaign);
          const transcript = this.buildSimulatedTranscript(
            campaign,
            contact,
            botProfile,
          );
          const scripts = this.transcriptToScripts(transcript);
          const analysis = this.buildCallAnalysis(
            campaign,
            contact,
            botProfile,
            sentimentScore,
          );
          const topicsCovered = this.buildTopicsCovered(campaign, botProfile);
          const endedAt = new Date();

          await this.db.callHistory.update({
            where: { id: call.id },
            data: {
              outcome: 'ANSWERED',
              status: 'COMPLETED',
              sessionStatus: 'completed',
              duration,
              endedAt,
              totalTime: endedAt.getTime() - startedAt.getTime(),
              recordingUrl,
              scripts,
              transcript,
              summary,
              sentimentScore,
              keyOutcomes,
              analysis,
              topicsCovered,
              endCallReason: 'The contact requested details and follow-up.',
              timestamp: new Date(),
            },
          });
          this.logger.debug(
            `Call ${call.id} completed as ANSWERED in ${duration}s`,
          );
        } else {
          await this.db.callHistory.update({
            where: { id: call.id },
            data: {
              outcome,
              sessionStatus: outcome === 'FAILED' ? 'failed' : 'completed',
              status:
                outcome === 'NO_ANSWER'
                  ? 'NO_ANSWER'
                  : outcome === 'BUSY'
                    ? 'BUSY'
                    : 'FAILED',
              duration: 0,
              endedAt: new Date(),
              totalTime: Date.now() - startedAt.getTime(),
              endCallReason:
                outcome === 'NO_ANSWER'
                  ? 'Contact did not answer.'
                  : outcome === 'BUSY'
                    ? 'Contact line was busy.'
                    : 'Simulation marked the call as failed.',
              sessionErrors:
                outcome === 'FAILED'
                  ? [
                      {
                        errorCode: 'SIMULATION_FAILED',
                        errorMessage: 'Simulated call failure.',
                      },
                    ]
                  : [],
              timestamp: new Date(),
            },
          });
          this.logger.debug(`Call ${call.id} completed as ${outcome}`);
        }
      }

      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
      this.logger.debug(`Call simulation completed for campaign ${campaignId}`);
    } catch (err) {
      this.logger.error(
        `Calling simulation error for campaign ${campaignId}`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'FAILED' },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Dashboard
  // ---------------------------------------------------------------------------

  async getDashboardMetrics() {
    const campaigns = await this.db.callingCampaign.findMany();
    const calls = await this.db.callHistory.findMany();

    const totalCampaigns = campaigns.length;
    const activeCampaigns = campaigns.filter(
      (c) => c.status === 'RUNNING',
    ).length;
    const scheduledCalls = calls.filter((c) => c.outcome === 'PENDING').length;
    const completedCalls = calls.filter((c) => c.outcome !== 'PENDING').length;

    return {
      totalCampaigns,
      activeCampaigns,
      scheduledCalls,
      completedCalls,
    };
  }

  // ---------------------------------------------------------------------------
  // Twilio webhooks
  // ---------------------------------------------------------------------------

  async initializeGeminiLiveCallSession(callId: string) {
    const call = await this.getCallWithContext(callId);
    if (!call) {
      throw new BadRequestException('Call could not be found.');
    }

    const botProfile = await this.resolveBotProfile(call.campaign);
    const { language: selectedLanguage, voice: selectedVoice } =
      this.resolveCallSelectedVoiceConfig(call);
    const contactName =
      `${call.contact.firstName || ''} ${call.contact.lastName || ''}`.trim() ||
      'Unknown';
    const languageInstruction =
      this.buildLiveCallLanguageInstruction(selectedLanguage);
    const systemInstruction = this.buildLiveCallingAgentPrompt({
      botProfile,
      call,
      contactName,
      campaignLanguage: selectedLanguage,
      selectedVoice,
      conversationLanguage: selectedLanguage,
      languageInstruction,
    });

    try {
      return await this.geminiLiveService.openCallSession({
        systemInstruction,
        voiceName: this.extractGeminiVoiceName(selectedVoice),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Gemini Live session failed for call ${callId}: ${reason}`,
      );
      await this.db.callHistory
        .update({
          where: { id: callId },
          data: {
            status: 'FAILED',
            outcome: 'FAILED',
            sessionStatus: 'failed',
            endedAt: new Date(),
            endCallReason: 'Gemini Live session could not be initialized.',
            errorMessage: `Gemini Live session could not be initialized: ${reason}`,
            sessionErrors: [
              ...(Array.isArray(call.sessionErrors) ? call.sessionErrors : []),
              {
                errorCode: 'GEMINI_LIVE_SESSION_INIT_FAILED',
                errorMessage: reason,
                timestamp: new Date().toISOString(),
              },
            ],
            timestamp: new Date(),
          },
        })
        .catch(() => undefined);
      throw new BadRequestException(
        'Gemini Live session could not be initialized.',
      );
    }
  }

  async handleTwilioAnswer(callId: string, body: any = {}) {
    try {
      this.logger.debug(
        'Twilio answer webhook received for call ' +
          callId +
          ': sid=' +
          (body?.CallSid || 'unknown') +
          ', status=' +
          (body?.CallStatus || 'unknown'),
      );
      const call = await this.getCallWithContext(callId);
      if (!call) {
        return await this.buildTwilioSayHangup(
          'Sorry, this call could not be found.',
        );
      }

      const botProfile = await this.resolveBotProfile(call.campaign);
      const opening = this.buildLiveOpeningScript(
        call.campaign,
        call.contact,
        botProfile,
      );
      this.logger.debug(
        `Twilio answer opening for call ${callId}; botTranscription=${JSON.stringify(opening)}`,
      );
      const scripts = this.ensureScripts(call.scripts);
      const nextScripts = scripts.length
        ? scripts
        : this.appendScriptTurn(scripts, 'agent', 'AI Agent', opening);
      const startedAt = call.startedAt ? new Date(call.startedAt) : new Date();
      const { language: selectedLanguage, voice: selectedVoice } =
        this.resolveCallSelectedVoiceConfig(call);
      this.logger.debug(
        `Twilio answer voice config for call ${callId}: language=${selectedLanguage}; voice=${selectedVoice}; voiceQuality=${call.campaign.voiceQuality || 'standard'}; storedLanguage=${call.selectedLanguage || 'not set'}; storedVoice=${call.selectedVoice || 'not set'}; campaignLanguage=${call.campaign.language || 'not set'}; campaignVoice=${call.campaign.voice || 'not set'}`,
      );

      await this.db.callHistory.update({
        where: { id: callId },
        data: {
          provider: 'TWILIO',
          providerCallSid: body.CallSid || call.providerCallSid || null,
          providerStatus: body.CallStatus || call.providerStatus || 'answered',
          status: 'IN_PROGRESS',
          outcome: 'IN_PROGRESS',
          sessionStatus: 'connected',
          startedAt,
          connectedAt: call.connectedAt || new Date(),
          selectedLanguage,
          selectedVoice,
          scripts: nextScripts,
          transcript: this.scriptsToTranscript(nextScripts),
          summary: `${botProfile.name} opened a live AI calling conversation with ${call.contact.firstName || 'the contact'}.`,
          topicsCovered: this.buildTopicsCovered(call.campaign, botProfile),
          analysis: {
            intent: 'live_ai_call_started',
            agentPersona: {
              name: botProfile.name,
              role: botProfile.role,
              personality: botProfile.personality,
            },
            guardrails: this.buildConversationGuardrails(
              call.campaign,
              botProfile,
            ),
          },
          timestamp: new Date(),
        },
      });

      call.selectedLanguage = selectedLanguage;
      call.selectedVoice = selectedVoice;

      const twiml = await this.buildTwilioGather(
        this.buildCallSpeechCampaign(call),
        opening,
        callId,
      );
      this.logger.debug(
        'Twilio answer TwiML for call ' + callId + ': ' + twiml,
      );
      return twiml;
    } catch (error) {
      this.logger.error(
        `Twilio answer webhook failed for call ${callId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return await this.buildTwilioSayHangup(
        'Sorry, we had a technical issue and need to end this call for now.',
      );
    }
  }

  async handleTwilioResponse(callId: string, body: any = {}) {
    try {
      this.logger.debug(
        'Twilio response webhook received for call ' +
          callId +
          ': sid=' +
          (body?.CallSid || 'unknown') +
          ', hasSpeech=' +
          String(Boolean(String(body?.SpeechResult || '').trim())),
      );

      const call = await this.getCallWithContext(callId);
      if (!call) {
        return await this.buildTwilioSayHangup(
          'Sorry, this call could not be found.',
        );
      }

      const speech = String(body.SpeechResult || '').trim();
      this.logger.debug(
        `Twilio user transcription for call ${callId}; userTranscription=${JSON.stringify(speech || '[empty]')}`,
      );
      const scripts = this.ensureScripts(call.scripts);
      const botProfile = await this.resolveBotProfile(call.campaign);

      // FIX 4: Use safeAnalysis() to guard against non-object JSON values stored
      // in the Prisma JSON field (e.g. null, string, array from old records).
      const existingAnalysis = this.safeAnalysis(call.analysis);
      const noInputCount = Number(existingAnalysis?.noInputCount || 0);

      if (!speech) {
        const nextNoInputCount = noInputCount + 1;
        if (nextNoInputCount >= 3) {
          const closing =
            'I could not hear you clearly, so I will end the call for now. Thank you for your time.';
          const endedScripts = this.appendScriptTurn(
            scripts,
            'agent',
            'AI Agent',
            closing,
          );
          await this.completeTwilioConversation(call, endedScripts, {
            reply: closing,
            shouldEnd: true,
            endReason: 'No speech detected after repeated prompts.',
            collectedData: {},
            sentimentScore: 5,
            keyOutcomes: 'Call ended because no clear speech was detected.',
            topicsCovered: this.buildTopicsCovered(
              call.campaign,
              await this.resolveBotProfile(call.campaign),
            ),
          });
          return await this.buildTwilioSayHangup(
            closing,
            this.buildCallSpeechCampaign(call),
          );
        }

        await this.db.callHistory.update({
          where: { id: callId },
          data: {
            analysis: {
              ...existingAnalysis,
              noInputCount: nextNoInputCount,
            },
            timestamp: new Date(),
          },
        });
        return await this.buildTwilioGather(
          this.buildCallSpeechCampaign(call),
          'Sorry, I did not catch that. Could you say that again?',
          callId,
        );
      }

      const withUserTurn = this.appendScriptTurn(
        scripts,
        'contact',
        'Customer',
        speech,
      );
      const conversationLanguage = this.detectConversationLanguage(
        call,
        speech,
        withUserTurn,
      );
      const conversationVoice =
        call.selectedVoice ||
        this.resolveGoogleTtsVoice(call.campaign.voice, conversationLanguage);
      if (
        call.selectedLanguage !== conversationLanguage ||
        call.selectedVoice !== conversationVoice
      ) {
        this.logger.debug(
          `Twilio voice config resolved for call ${callId}; language=${conversationLanguage}; selectedLanguage=${call.selectedLanguage || 'not set'}; selectedVoice=${call.selectedVoice || 'not set'}`,
        );
      }
      call.selectedLanguage = conversationLanguage;
      call.selectedVoice = conversationVoice;
      let responseBudgetTimer: NodeJS.Timeout | null = null;
      try {
        const buildFallback = () =>
          this.buildLiveTurnFallback(
            call,
            speech,
            withUserTurn,
            conversationLanguage,
            botProfile,
          );
        const generation = await Promise.race([
          this.generateNextCallingTurn(call, speech, withUserTurn).catch(
            (error) => {
              this.logger.warn(
                `Gemini API live calling turn failed for call ${callId}; using fallback response. Reason: ${error instanceof Error ? error.message : String(error)}`,
              );
              return buildFallback();
            },
          ),
          new Promise<ConversationGeneration>((resolve) => {
            responseBudgetTimer = setTimeout(() => {
              this.logger.warn(
                `Twilio response generation timed out for call ${callId}; using fallback response.`,
              );
              resolve(buildFallback());
            }, this.getTwilioResponseBudgetMs());
          }),
        ]);
        this.logger.debug(
          `Twilio bot transcription for call ${callId}; botTranscription=${JSON.stringify(generation.reply)}`,
        );
        const nextScripts = this.appendScriptTurn(
          withUserTurn,
          'agent',
          'AI Agent',
          generation.reply,
        );
        const shouldEnd = this.shouldEndConversationNow(speech, generation);
        const finalGeneration = shouldEnd
          ? {
              ...generation,
              shouldEnd: true,
              endReason:
                generation.endReason ||
                this.buildGoalCompletionEndReason(call, botProfile, speech),
            }
          : {
              ...generation,
              shouldEnd: false,
              endReason: '',
            };

        if (shouldEnd) {
          await this.completeTwilioConversation(
            call,
            nextScripts,
            finalGeneration,
          );
          return await this.buildTwilioSayHangup(
            finalGeneration.reply,
            this.buildCallSpeechCampaign(call),
          );
        }

        await this.db.callHistory.update({
          where: { id: callId },
          data: {
            status: 'IN_PROGRESS',
            outcome: 'IN_PROGRESS',
            sessionStatus: 'connected',
            selectedLanguage: conversationLanguage,
            selectedVoice: conversationVoice,
            scripts: nextScripts,
            transcript: this.scriptsToTranscript(nextScripts),
            summary: `${botProfile.name} is speaking with ${call.contact.firstName || 'the contact'} about ${call.campaign.objective || 'the campaign objective'}.`,
            sentimentScore: finalGeneration.sentimentScore,
            keyOutcomes: finalGeneration.keyOutcomes,
            topicsCovered: finalGeneration.topicsCovered,
            analysis: {
              ...existingAnalysis,
              noInputCount: 0,
              collectedData: finalGeneration.collectedData,
              lastAiDecision: {
                shouldEnd: finalGeneration.shouldEnd,
                endReason: finalGeneration.endReason,
              },
            },
            timestamp: new Date(),
          },
        });

        return await this.buildTwilioGather(
          this.buildCallSpeechCampaign(call),
          finalGeneration.reply,
          callId,
        );
      } finally {
        if (responseBudgetTimer) {
          clearTimeout(responseBudgetTimer);
        }
      }
    } catch (error) {
      this.logger.error(
        `Twilio response webhook failed for call ${callId}`,
        error instanceof Error ? error.stack : String(error),
      );
      return await this.buildTwilioSayHangup(
        'Sorry, we had a technical issue and need to end this call for now.',
      );
    }
  }

  async handleTwilioStatus(callId: string, body: any = {}) {
    const status = body.CallStatus || body.CallStatusCallbackEvent || 'unknown';
    this.logger.debug(
      'Twilio status webhook received for call ' +
        callId +
        ': sid=' +
        (body?.CallSid || 'unknown') +
        ', status=' +
        status +
        ', duration=' +
        String(body?.CallDuration || '') +
        ', answeredBy=' +
        String(body?.AnsweredBy || '') +
        ', errorCode=' +
        String(body?.ErrorCode || '') +
        ', errorMessage=' +
        String(body?.ErrorMessage || ''),
    );
    const data: Record<string, unknown> = {
      provider: 'TWILIO',
      providerCallSid: body.CallSid || undefined,
      providerStatus: status,
      timestamp: new Date(),
    };

    if (status === 'initiated') {
      data.status = 'QUEUING';
      data.outcome = 'QUEUING';
      data.sessionStatus = 'inprogress';
    } else if (status === 'ringing') {
      data.status = 'RINGING';
      data.outcome = 'RINGING';
    } else if (status === 'in-progress' || status === 'answered') {
      data.status = 'CONNECTED';
      data.outcome = 'CONNECTED';
      data.sessionStatus = 'connected';
      data.connectedAt = new Date();
    } else if (status === 'completed') {
      const call = await this.db.callHistory.findUnique({
        where: { id: callId },
      });
      data.endedAt = new Date();
      data.duration = Number(body.CallDuration || call?.duration || 0);
      data.totalTime = call?.startedAt
        ? Date.now() - new Date(call.startedAt).getTime()
        : undefined;
      const currentOutcome = call?.outcome ?? '';
      if (!['ANSWERED', 'COMPLETED'].includes(currentOutcome)) {
        data.status = 'COMPLETED';
        data.outcome = call?.transcript ? 'ANSWERED' : 'NO_ANSWER';
        data.sessionStatus = 'completed';
      }
    } else if (['busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
      data.status =
        status === 'busy'
          ? 'BUSY'
          : status === 'no-answer'
            ? 'NO_ANSWER'
            : status === 'canceled'
              ? 'CANCELLED'
              : 'FAILED';
      data.outcome = data.status;
      data.sessionStatus = status === 'failed' ? 'failed' : 'completed';
      data.endedAt = new Date();
      data.endCallReason = `Twilio call status: ${status}.`;
      data.errorMessage = body.ErrorMessage || null;
    }

    await this.db.callHistory.update({
      where: { id: callId },
      data,
    });

    // FIX 2: After every terminal Twilio status, check whether all calls for the
    // campaign have settled so we can auto-transition the campaign to COMPLETED.
    if (TERMINAL_TWILIO_STATUSES.has(status)) {
      const updatedCall = await this.db.callHistory
        .findUnique({ where: { id: callId } })
        .catch(() => null);
      if (updatedCall?.campaignId) {
        void this.checkAndCompleteCampaign(updatedCall.campaignId);
      }
    }

    return { success: true };
  }

  async handleTwilioRecording(callId: string, body: any = {}) {
    const recordingUrl = body.RecordingUrl ? `${body.RecordingUrl}.mp3` : null;
    const call = await this.db.callHistory.findUnique({
      where: { id: callId },
    });

    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        recordingUrl,
        providerStatus:
          body.RecordingStatus || call?.providerStatus || 'recorded',
        duration: Number(body.RecordingDuration || call?.duration || 0),
        // FIX 8: Use safeAnalysis() to guard against non-object JSON field values.
        analysis: {
          ...this.safeAnalysis(call?.analysis),
          recording: {
            sid: body.RecordingSid,
            status: body.RecordingStatus,
            duration: Number(body.RecordingDuration || 0),
          },
        },
        timestamp: new Date(),
      },
    });
    return { success: true };
  }

  // ---------------------------------------------------------------------------
  // Campaign auto-completion (FIX 2)
  // ---------------------------------------------------------------------------

  /**
   * Checks whether every call in a campaign has reached a terminal outcome
   * and, if so, transitions the campaign status to COMPLETED.
   * Called after each terminal Twilio status webhook so the campaign settles
   * automatically without a separate polling job.
   */
  private async checkAndCompleteCampaign(campaignId: string) {
    try {
      const campaign = await this.db.callingCampaign.findUnique({
        where: { id: campaignId },
        include: { calls: { select: { outcome: true } } },
      });
      if (!campaign || campaign.status !== 'RUNNING') return;

      const allSettled = (campaign.calls as Array<{ outcome?: string }>).every(
        (call) => TERMINAL_CALL_OUTCOMES.has(call.outcome || ''),
      );
      if (!allSettled) return;

      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
      this.logger.debug(
        `Campaign ${campaignId} auto-completed: all calls have settled`,
      );
    } catch (err) {
      this.logger.error(
        `checkAndCompleteCampaign failed for ${campaignId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Contact management
  // ---------------------------------------------------------------------------

  private async addCallableContacts(campaignId: string, contactIds: string[]) {
    if (!contactIds.length) return { added: 0, skipped: 0 };

    const uniqueContactIds = new Set(contactIds);
    const [contacts, existingCalls] = await Promise.all([
      this.db.contact.findMany(),
      this.db.callHistory.findMany({
        where: { campaignId },
        select: { contactId: true },
      }),
    ]);

    const contactMap = new Map(
      contacts
        .filter((contact) => uniqueContactIds.has(contact.id))
        .map((contact) => [contact.id, contact]),
    );
    const existingContactIds = new Set(
      existingCalls
        .map((call) => call.contactId)
        .filter((contactId) => uniqueContactIds.has(contactId)),
    );
    let added = 0;
    let skipped = 0;
    const requestContactIds = new Set<string>();
    const creates: Promise<unknown>[] = [];

    for (const contactId of contactIds) {
      if (requestContactIds.has(contactId)) {
        skipped++;
        continue;
      }
      requestContactIds.add(contactId);

      const contact = contactMap.get(contactId);

      if (!contact) {
        skipped++;
        this.logger.warn(
          `Skipping contact ${contactId} for campaign ${campaignId}: contact not found`,
        );
        continue;
      }

      if (!this.hasCallablePhone(contact)) {
        skipped++;
        this.logger.warn(
          `Skipping contact ${contactId} for campaign ${campaignId}: missing phone number`,
        );
        continue;
      }

      if (existingContactIds.has(contactId)) {
        skipped++;
        this.logger.debug(
          `Skipping contact ${contactId} for campaign ${campaignId}: call already exists`,
        );
        continue;
      }

      existingContactIds.add(contactId);
      creates.push(
        this.db.callHistory.create({
          data: {
            campaignId,
            contactId,
            outcome: 'PENDING',
            status: 'PENDING',
            sessionStatus: 'pending',
            callType: 'phone_call',
            duration: 0,
            scripts: [],
            topicsCovered: [],
            sessionErrors: [],
          },
        }),
      );
      added++;
    }

    await Promise.all(creates);
    return { added, skipped };
  }

  // ---------------------------------------------------------------------------
  // Campaign generation helpers
  // ---------------------------------------------------------------------------

  private buildMockGeneratedCampaign(userPrompt: string, tone: string) {
    return this.normalizeGeneratedCampaign(
      {
        name: 'AI Calling Campaign',
        objective:
          'Call selected contacts, qualify interest, and capture the next best follow-up.',
        prompt: userPrompt,
        botName: 'Alex',
        botRole: 'calling specialist',
        botGoal: 'Qualify relevance and capture the next best follow-up step.',
        botPersonality: tone,
        botKnowledge: userPrompt,
        botRules:
          'Ask permission before continuing. Keep the call brief. Do not overpromise. Confirm the next step before ending.',
        botObjectionHandling:
          'If they are busy, ask for a better callback time. If they are unsure, offer to send details. If they are not interested, thank them politely and close.',
        botGreeting:
          'Hi {{firstName}}, this is {{botName}}. I know this is a quick call, so I will be brief.',
        voice: 'google:en-IN-Chirp3-HD-Puck',
        language: 'en-IN',
      },
      userPrompt,
      tone,
    );
  }

  private normalizeGeneratedCampaign(
    value: Record<string, any>,
    userPrompt: string,
    tone: string,
  ) {
    const allowedVoices = new Set(
      this.aiCallingBotsService
        ?.getGoogleVoiceProfiles()
        .map((profile) => profile.voice) || [],
    );

    const pick = (key: string, fallback: string) => {
      const text = typeof value?.[key] === 'string' ? value[key].trim() : '';
      return text || fallback;
    };
    const rawVoice = typeof value?.voice === 'string' ? value.voice.trim() : '';
    const rawLanguage =
      typeof value?.language === 'string' ? value.language.trim() : '';

    return {
      name: pick('name', 'AI Calling Campaign').slice(0, 90),
      objective: pick(
        'objective',
        'Call contacts, qualify interest, and capture the next step.',
      ),
      prompt: pick('prompt', userPrompt),
      botName: pick('botName', 'Alex'),
      botRole: pick('botRole', 'calling specialist'),
      botGoal: pick(
        'botGoal',
        'Qualify relevance and capture the next best follow-up step.',
      ),
      botPersonality: pick('botPersonality', tone),
      botKnowledge: pick('botKnowledge', userPrompt),
      botRules: pick(
        'botRules',
        'Ask permission before continuing. Keep the call brief. Do not overpromise.',
      ),
      botObjectionHandling: pick(
        'botObjectionHandling',
        'If they are busy, ask for a better callback time. If they are unsure, offer to send details.',
      ),
      botGreeting: pick(
        'botGreeting',
        'Hi {{firstName}}, this is {{botName}}. I know this is a quick call, so I will be brief.',
      ),
      voice: allowedVoices.has(rawVoice)
        ? rawVoice
        : this.normalizeCampaignVoice(rawVoice, rawLanguage),
      language: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(rawLanguage)
        ? this.normalizeLanguageCode(rawLanguage)
        : this.inferLanguageFromVoice(rawVoice),
    };
  }

  private parseJsonObject(content: string) {
    const raw = String(content || '').trim();
    if (!raw) {
      throw new Error('Model response was empty');
    }

    let cleanedJson = raw;
    if (cleanedJson.startsWith('```')) {
      cleanedJson = cleanedJson
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    }

    try {
      return JSON.parse(cleanedJson);
    } catch {
      const match = cleanedJson.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error('Model response did not contain a valid JSON object');
      }
      return JSON.parse(match[0]);
    }
  }

  private async applyAiCallingBotDefaults(data: Record<string, any>) {
    const hasVoiceOrLanguage =
      Object.prototype.hasOwnProperty.call(data, 'voice') ||
      Object.prototype.hasOwnProperty.call(data, 'language');
    if (!data.aiCallingBotId && !hasVoiceOrLanguage) return data;

    const defaults: Record<string, any> = data.aiCallingBotId
      ? await this.aiCallingBotsService.getCampaignDefaults(data.aiCallingBotId)
      : {};
    const merged: Record<string, any> = {
      ...defaults,
      ...data,
      voice: data.voice || defaults?.voice,
      language: data.language || defaults?.language,
      botName: data.botName || defaults?.botName,
      botRole: data.botRole || defaults?.botRole,
      botGoal: data.botGoal || defaults?.botGoal,
      botPersonality: data.botPersonality || defaults?.botPersonality,
      botKnowledge: data.botKnowledge || defaults?.botKnowledge,
      botRules: data.botRules || defaults?.botRules,
      botObjectionHandling:
        data.botObjectionHandling || defaults?.botObjectionHandling,
      botGreeting: data.botGreeting || defaults?.botGreeting,
    };
    if (!merged.aiCallingBotId && merged.voiceQuality !== 'hd') {
      return merged;
    }

    const language = this.resolveGoogleVoiceLanguage(
      merged.language,
      merged.voice,
    );

    return {
      ...merged,
      language,
      voice: this.normalizeCampaignVoice(merged.voice, language),
    };
  }

  private normalizeCampaignVoiceInput(data: Record<string, any>) {
    const rawLanguage =
      typeof data.language === 'string' ? data.language.trim() : '';
    const rawVoice = typeof data.voice === 'string' ? data.voice.trim() : '';
    const selectedLanguage =
      typeof data.selectedLanguage === 'string'
        ? data.selectedLanguage.trim()
        : '';
    const selectedVoice =
      typeof data.selectedVoice === 'string' ? data.selectedVoice.trim() : '';

    const next = { ...data } as Record<string, any>;
    if (selectedLanguage) {
      next.language = selectedLanguage;
    } else if (rawLanguage) {
      next.language = rawLanguage;
    }

    if (selectedVoice) {
      next.voice = selectedVoice;
    } else if (rawVoice) {
      next.voice = rawVoice;
    }

    delete next.selectedLanguage;
    delete next.selectedVoice;

    return next;
  }

  // ---------------------------------------------------------------------------
  // Google TTS / HD audio
  // ---------------------------------------------------------------------------

  async renderGoogleSpeechAudio(audioId: string) {
    const cached = this.googleSpeechCache.get(audioId);
    if (!cached) {
      this.logger.warn(
        'Twilio TTS audio cache miss for audioId=' +
          audioId +
          '; cacheSize=' +
          String(this.googleSpeechCache.size),
      );
      throw new BadRequestException('Google speech audio was not found.');
    }

    this.logger.debug(
      'Twilio TTS audio cache hit for audioId=' +
        audioId +
        '; bytes=' +
        String(cached.audio.length),
    );
    return cached.audio;
  }

  private async registerGoogleSpeech(
    text: string,
    voice: string,
    language?: string,
  ) {
    const now = Date.now();
    // Opportunistic eviction of stale entries (periodic pruner in onModuleInit
    // handles background cleanup; this cleans entries created within same request).
    for (const [id, cached] of this.googleSpeechCache.entries()) {
      if (now - cached.createdAt > 10 * 60 * 1000) {
        this.googleSpeechCache.delete(id);
      }
    }

    const accessToken = await this.getGoogleTtsAccessToken();
    if (!accessToken) {
      this.logger.warn(
        'Google TTS auth is disabled for HD AI calling audio; falling back to Twilio Say.',
      );
      return null;
    }

    const normalizedLanguage = this.normalizeLanguageCode(language) || 'en-IN';
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.getGoogleTtsTimeoutMs(),
    );

    try {
      const response = await fetch(
        'https://texttospeech.googleapis.com/v1/text:synthesize',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify({
            input: { text: this.compactForSpeech(text, 460) },
            voice: {
              languageCode: normalizedLanguage,
              name: voice,
            },
            audioConfig: {
              audioEncoding: 'MP3',
              speakingRate: normalizedLanguage === 'hi-IN' ? 0.96 : 1.02,
              pitch: 0,
            },
          }),
        },
      );

      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.audioContent) {
        this.logger.warn(
          `Google TTS failed for HD AI calling audio; falling back to Twilio Say. Reason: ${data?.error?.message || response.statusText || 'empty audio response'}`,
        );
        return null;
      }

      const audio = Buffer.from(data.audioContent, 'base64');
      if (!audio.length) {
        this.logger.warn(
          'Google TTS returned empty HD AI calling audio; falling back to Twilio Say.',
        );
        return null;
      }

      const audioId = randomUUID();
      this.googleSpeechCache.set(audioId, { audio, createdAt: now });
      return audioId;
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `timed out after ${this.getGoogleTtsTimeoutMs()}ms`
          : error instanceof Error
            ? error.message
            : String(error);
      this.logger.warn(
        `Google TTS could not prepare HD AI calling audio; falling back to Twilio Say. Reason: ${reason}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------------------------------------------------------------------------
  // Relaunch helpers
  // ---------------------------------------------------------------------------

  private async resetCallsForRelaunch(calls: any[]) {
    await Promise.all(
      calls.map((call) =>
        this.db.callHistory.update({
          where: { id: call.id },
          data: {
            duration: 0,
            outcome: 'PENDING',
            status: 'PENDING',
            transcript: null,
            recordingUrl: null,
            scripts: [],
            summary: null,
            sentimentScore: 5.0,
            keyOutcomes: null,
            analysis: null,
            topicsCovered: [],
            endCallReason: null,
            sessionStatus: 'pending',
            selectedLanguage: null,
            selectedVoice: null,
            startedAt: null,
            connectedAt: null,
            endedAt: null,
            startupTime: null,
            totalTime: null,
            sessionErrors: [],
            deviceLogs: null,
            provider: null,
            providerCallSid: null,
            providerStatus: null,
            errorMessage: null,
            timestamp: new Date(),
          },
        }),
      ),
    );
  }

  private isCallCancellable(call: any) {
    const status = String(call?.status || '').toUpperCase();
    const outcome = String(call?.outcome || '').toUpperCase();
    return (
      [
        'PENDING',
        'QUEUING',
        'QUEUED',
        'DIALING',
        'RINGING',
        'CONNECTED',
        'IN_PROGRESS',
      ].includes(status) ||
      [
        'PENDING',
        'QUEUING',
        'QUEUED',
        'DIALING',
        'RINGING',
        'CONNECTED',
        'IN_PROGRESS',
      ].includes(outcome)
    );
  }

  // ---------------------------------------------------------------------------
  // Twilio API client
  // ---------------------------------------------------------------------------

  private hasUsableTwilioSettings(settings?: TwilioSettings | null) {
    return Boolean(
      settings?.twilioStatus === 'CONNECTED' &&
      settings.twilioAccountSid?.trim() &&
      settings.twilioAuthToken?.trim() &&
      settings.twilioPhoneNumber?.trim(),
    );
  }

  private async createTwilioCall({
    accountSid,
    authToken,
    from,
    to,
    url,
    statusCallback,
    recordingStatusCallback,
  }: {
    accountSid: string;
    authToken: string;
    from: string;
    to: string;
    url: string;
    statusCallback: string;
    recordingStatusCallback: string;
  }): Promise<
    { ok: true; sid: string; status: string } | { ok: false; error: string }
  > {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const body = new URLSearchParams({
      To: to,
      From: from,
      Url: url,
      Method: 'POST',
      StatusCallback: statusCallback,
      StatusCallbackMethod: 'POST',
      Record: 'true',
      RecordingStatusCallback: recordingStatusCallback,
      RecordingStatusCallbackMethod: 'POST',
    });
    ['initiated', 'ringing', 'answered', 'completed'].forEach((event) =>
      body.append('StatusCallbackEvent', event),
    );
    body.append('MachineDetection', 'Enable');
    body.append('AsyncAmd', 'true');

    try {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        return {
          ok: false,
          error:
            data?.message ||
            data?.error_message ||
            `Twilio API error ${response.status} ${response.statusText}`,
        };
      }

      return {
        ok: true,
        sid: data?.sid || '',
        status: data?.status || 'queued',
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async stopTwilioCall({
    accountSid,
    authToken,
    callSid,
  }: {
    accountSid: string;
    authToken: string;
    callSid: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    let lastError = 'Twilio stop request failed';
    const attempts = ['canceled', 'completed'];

    for (const status of attempts) {
      try {
        const body = new URLSearchParams({ Status: status });
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
          },
        );
        const data = await response.json().catch(() => null);
        if (response.ok) {
          return { ok: true };
        }
        lastError =
          data?.message ||
          data?.error_message ||
          `Twilio API error ${response.status} ${response.statusText}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    return { ok: false, error: lastError };
  }

  // ---------------------------------------------------------------------------
  // TwiML builders
  // ---------------------------------------------------------------------------

  private async buildTwilioGather(
    campaign: any,
    message: string,
    callId: string,
  ) {
    const language = this.normalizeLanguageCode(campaign?.language);
    const gatherLanguage = this.resolveTwilioGatherLanguage(language);

    const action = this.escapeXml(this.getTwilioWebhookUrl('respond', callId));

    const prompt = await this.buildTwilioSpeechNoun(
      campaign,
      message,
      language,
    );

    return `
<Response>
  <Gather
    input="speech"
    action="${action}"
    method="POST"
    speechTimeout="${this.getTwilioSpeechTimeoutSeconds()}"
    timeout="15"
    actionOnEmptyResult="true"
    enhanced="true"
    profanityFilter="false"
    ${gatherLanguage ? `language="${gatherLanguage}"` : ''}
  >
    ${prompt}
  </Gather>

  <Redirect method="POST">
    ${action}
  </Redirect>
</Response>
`.trim();
  }

  private async buildTwilioSayHangup(message: string, campaign?: any) {
    const language = this.normalizeLanguageCode(campaign?.language);
    const speech = await this.buildTwilioSpeechNoun(
      campaign,
      message,
      language,
    );

    return `<Response>${speech}<Hangup /></Response>`;
  }

  private async buildTwilioSpeechNoun(
    campaign: any,
    message: string,
    language?: string,
  ) {
    if (campaign?.voiceQuality === 'hd' && this.isTwilioHdPlayEnabled()) {
      const googleTtsVoice = this.resolveGoogleTtsVoice(
        campaign?.voice,
        language,
      );
      const audioId = await this.registerGoogleSpeech(
        message,
        googleTtsVoice,
        language,
      );
      if (audioId) {
        const audioUrl = this.getTwilioTtsUrl(audioId);
        this.logger.debug(
          'Prepared HD Twilio TTS audio: audioId=' +
            audioId +
            ', url=' +
            audioUrl +
            ', textLength=' +
            String(message.length),
        );
        return `<Play>${this.escapeXml(audioUrl)}</Play>`;
      }
    }

    return this.buildTwilioSayNoun(campaign, message, language);
  }

  private buildTwilioSayNoun(
    campaign: any,
    message: string,
    language?: string,
  ) {
    const twilioVoice = this.resolveTwilioVoice(campaign?.voice, language);
    const sayAttrs = this.buildSayAttributes(twilioVoice, language);
    return `<Say${sayAttrs}>${this.escapeXml(message)}</Say>`;
  }

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------

  private getTwilioTtsUrl(audioId: string) {
    return `${this.getPublicApiBaseUrl()}/calling-campaigns/twilio/tts/${encodeURIComponent(audioId)}`;
  }

  private getPublicApiBaseUrl() {
    const configured =
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('BACKEND_PUBLIC_URL') ||
      this.configService.get<string>('API_BASE_URL');
    const base =
      configured?.trim() ||
      `http://localhost:${this.configService.get<number>('PORT', 3001)}`;
    const withoutSlash = base.replace(/\/+$/, '');
    return withoutSlash.endsWith('/api') ? withoutSlash : `${withoutSlash}/api`;
  }

  private assertPublicTwilioWebhookUrl() {
    const webhookBaseUrl = this.getPublicApiBaseUrl();
    if (this.isLocalWebhookUrl(webhookBaseUrl)) {
      throw new BadRequestException(
        `Twilio calling requires PUBLIC_API_URL to be a public HTTPS backend URL. Current webhook base is ${webhookBaseUrl}. For local testing, use an HTTPS tunnel such as ngrok and set PUBLIC_API_URL=https://your-tunnel-url/api.`,
      );
    }

    if (!webhookBaseUrl.startsWith('https://')) {
      throw new BadRequestException(
        `Twilio calling requires PUBLIC_API_URL to use HTTPS. Current webhook base is ${webhookBaseUrl}.`,
      );
    }
  }

  private isLocalWebhookUrl(value: string) {
    return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(
      value,
    );
  }

  private getTwilioWebhookUrl(
    type: 'answer' | 'respond' | 'status' | 'recording',
    callId: string,
  ) {
    return `${this.getPublicApiBaseUrl()}/calling-campaigns/twilio/${type}/${encodeURIComponent(callId)}`;
  }

  // ---------------------------------------------------------------------------
  // Conversation / script helpers
  // ---------------------------------------------------------------------------

  private async getCallWithContext(callId: string) {
    return this.db.callHistory.findUnique({
      where: { id: callId },
      include: {
        campaign: true,
        contact: true,
      },
    });
  }

  private buildBotProfile(campaign: any) {
    return buildAgentPersona({
      name: campaign.botName,
      role: campaign.botRole,
      goal: campaign.botGoal || campaign.objective,
      personality: campaign.botPersonality,
      language: campaign.language,
      knowledge: campaign.botKnowledge || campaign.prompt,
      rules:
        campaign.botRules ||
        'ask permission before continuing, listen first, keep the call brief, and never overpromise',
      objections:
        campaign.botObjectionHandling ||
        'if the contact is busy, ask for a better callback time; if they are unsure, offer to send details',
      greeting: campaign.botGreeting,
    });
  }

  private async resolveBotProfile(campaign: any) {
    const defaults = campaign.aiCallingBotId
      ? await this.aiCallingBotsService.getCampaignDefaults(
          campaign.aiCallingBotId,
        )
      : {};
    return this.buildBotProfile({
      ...defaults,
      ...campaign,
      botKnowledge: campaign.botKnowledge || defaults.botKnowledge,
      botGoal: campaign.botGoal || defaults.botGoal,
    });
  }

  private buildOpeningScript(campaign: any, contact: any, botProfile: any) {
    const company = contact.company || 'your team';
    const objective =
      campaign.objective ||
      'check whether this is relevant and find the best next step';
    const greeting = this.applyBotVariables(
      botProfile.greeting ||
        `Hi {{firstName}}, this is ${botProfile.name}. I know this is a cold call, so I will be brief.`,
      contact,
      campaign,
      botProfile,
    );
    const context = this.sentenceFromText(
      botProfile.knowledge ||
        campaign.prompt ||
        'I am calling with a quick update that may be useful.',
    );
    const rules = this.sentenceFromText(botProfile.rules);
    const objections = this.sentenceFromText(botProfile.objections);

    return [
      greeting,
      `I am ${botProfile.name}, a ${botProfile.role}, calling about ${objective}.`,
      `I will keep this ${this.sentenceFromText(botProfile.personality).toLowerCase()}`,
      `I wanted to see if this is relevant for ${company}, share the key context, and ask one or two quick questions before suggesting a next step.`,
      context,
      objections
        ? `If you are unsure, I can handle common concerns like this: ${objections}`
        : '',
      `If now is not a good time, no problem. I can note a better callback time or send the details instead.`,
      rules ? `I will keep this simple: ${rules}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  private buildLiveOpeningScript(campaign: any, contact: any, botProfile: any) {
    const greeting = this.applyBotVariables(
      botProfile.greeting || `Hi {{firstName}}, this is ${botProfile.name}.`,
      contact,
      campaign,
      botProfile,
    );
    const firstSentence = this.firstSentence(greeting);
    const objective = this.stripSentenceEnding(
      this.compactForSpeech(campaign.objective || 'a quick follow-up', 90),
    );
    return this.compactForSpeech(
      `${firstSentence} I am calling about ${objective}. I will keep this brief. Is now a good time?`,
      220,
    );
  }

  private buildSimulatedTranscript(
    campaign: any,
    contact: any,
    botProfile: any,
  ) {
    const firstName = contact.firstName || 'there';
    const objective =
      campaign.objective || 'understanding whether there is a useful next step';
    const knowledge =
      botProfile.knowledge ||
      'the offer, qualification criteria, and follow-up process';
    const objections = this.sentenceFromText(botProfile.objections);
    const personality = this.sentenceFromText(botProfile.personality);

    return `AI Agent: ${this.buildOpeningScript(campaign, contact, botProfile)}
Customer: Hi ${botProfile.name}. I have a minute. What is this about?
AI Agent: Thanks, ${firstName}. I will keep the tone ${personality.toLowerCase()} In short, I am calling about ${objective}. Before I explain more, can I ask what matters most to you right now?
Customer: Sure. I mainly want to understand whether this is relevant for me.
AI Agent: That makes sense. Based on what I have here, the important context is ${knowledge}. Does that sound close to what you are looking for?
Customer: It could be. I would need more details before deciding.
AI Agent: Absolutely. ${objections} I can send the details and mark you for a follow-up, or we can schedule a short next call.
Customer: Please send the details and follow up later.
AI Agent: Done. I will share the context with the team and make sure the next message is specific to what we discussed. Thanks for taking the call.`;
  }

  private transcriptToScripts(transcript: string) {
    return transcript
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const [speakerLabel, ...rest] = line.split(':');
        const speaker =
          speakerLabel === 'Customer'
            ? 'contact'
            : speakerLabel.includes('Agent')
              ? 'agent'
              : 'system';

        return {
          turn: index + 1,
          speaker,
          label: speakerLabel,
          text: rest.join(':').trim() || line,
          timestamp: new Date().toISOString(),
        };
      });
  }

  private ensureScripts(value: any): Array<Record<string, any>> {
    return Array.isArray(value) ? value : [];
  }

  private appendScriptTurn(
    scripts: Array<Record<string, any>>,
    speaker: 'agent' | 'contact',
    label: 'AI Agent' | 'Customer',
    text: string,
  ) {
    return [
      ...scripts,
      {
        turn: scripts.length + 1,
        speaker,
        label,
        text,
        timestamp: new Date().toISOString(),
      },
    ];
  }

  private countScriptTurns(
    scripts: Array<Record<string, any>>,
    speaker: 'agent' | 'contact',
  ) {
    return scripts.filter((script) => script.speaker === speaker).length;
  }

  private scriptsToTranscript(scripts: Array<Record<string, any>>) {
    return scripts
      .map((script) => `${script.label || 'System'}: ${script.text || ''}`)
      .join('\n');
  }

  private buildConversationGuardrails(campaign: any, botProfile: any) {
    return [
      `Objective: ${campaign.objective || 'find the best next step'}`,
      `Goal: ${botProfile.goal || campaign.objective || 'capture a clear next step'}`,
      `Persona: ${botProfile.name}, ${botProfile.role}`,
      `Greeting: ${botProfile.greeting || 'not provided'}`,
      `Knowledge: ${botProfile.knowledge || 'not provided'}`,
      `Rules: ${botProfile.rules}`,
      `Objections: ${botProfile.objections}`,
      'Use only the provided campaign context. Do not invent facts. Ask one question at a time. Wait for the user after every reply.',
    ];
  }

  private buildRoleAwareFallbackReply(
    call: any,
    botProfile: any,
    userTurns: number,
    latestUserSpeech: string,
    language?: string,
    knowledgeContext = '',
    scripts: Array<Record<string, any>> = [],
  ) {
    const firstName = call.contact.firstName || 'there';
    const hindi = this.isHindiLanguage(language);
    const objective = this.stripSentenceEnding(
      this.compactForSpeech(
        botProfile.goal ||
          call.campaign.objective ||
          botProfile.knowledge ||
          call.campaign.prompt ||
          'this conversation',
        90,
      ),
    );
    const contextualKnowledge = [
      knowledgeContext,
      botProfile.knowledge,
      call.campaign.prompt,
    ]
      .filter(Boolean)
      .join('\n');
    const contextSummary = extractRelevantKnowledgeSummary(
      latestUserSpeech,
      contextualKnowledge,
      170,
      scripts as AgentScriptTurn[],
    );
    const lowInformationTurn = isLowInformationTurn(latestUserSpeech);
    const asksForPrompt = this.isPromptExposureRequest(latestUserSpeech);

    if (asksForPrompt) {
      if (hindi) {
        return `मैं यह जानकारी साझा नहीं कर सकता. लेकिन ${botProfile.role} के रूप में आपकी मदद कर सकता हूँ. कृपया बताइए आपको किस जानकारी की जरूरत है.`;
      }
      return `I'm not able to share that information. I can still help as your ${botProfile.role}. Tell me what information you need and I will keep it practical.`;
    }

    if (hindi) {
      if (lowInformationTurn) {
        return `धन्यवाद, ${firstName}. ${contextSummary}. आपके लिए सबसे उपयोगी बात पहले कौन सी रहेगी?`;
      }
      return userTurns <= 1
        ? `ज़रूर, ${firstName}. ${contextSummary}. अगर आप चाहें तो मैं अगला कदम भी साफ़ तरीके से बता दूँ.`
        : `समझ गया. ${contextSummary}. यदि ठीक लगे तो हम इसका अगला कदम तय कर सकते हैं.`;
    }

    if (lowInformationTurn) {
      return `Thanks, ${firstName}. ${contextSummary} What would you like to cover next?`;
    }

    return userTurns <= 1
      ? `Sure, ${firstName}. ${contextSummary} If useful, I can help with the next step for ${objective}.`
      : `${contextSummary} If you want, we can move to the next step now.`;
  }

  private buildLiveCallIdealPath(campaign: any, botProfile: any) {
    const objective = this.stripSentenceEnding(
      this.compactForSpeech(
        botProfile.goal ||
          campaign.objective ||
          botProfile.knowledge ||
          campaign.prompt ||
          'the campaign objective',
        120,
      ),
    );

    return [
      'Confirm the contact has a moment to talk.',
      `Explain the reason for calling: ${objective}.`,
      'Use the campaign objective, bot knowledge, and RAC (Retrieved Answer Context) to answer direct questions first.',
      'Ask one relevant question at a time based on the configured bot goal and available training context.',
      'Offer a clear next step only when it fits the configured goal and the contact intent.',
      'End politely only when the contact declines or the configured goal has been achieved.',
    ].join('\n- ');
  }

  private buildLiveCallingAgentPrompt(input: {
    botProfile: any;
    call: any;
    contactName: string;
    campaignLanguage: string;
    selectedVoice: string;
    conversationLanguage: string;
    languageInstruction: string;
  }) {
    return buildLiveCallingSystemPrompt({
      persona: buildAgentPersona({
        name: input.botProfile.name,
        role: input.botProfile.role,
        goal: input.botProfile.goal,
        personality: input.botProfile.personality,
        language: input.campaignLanguage,
        knowledge: input.botProfile.knowledge,
        rules: input.botProfile.rules,
        greeting: input.botProfile.greeting,
        objections: input.botProfile.objections,
      }),
      contactName: input.contactName,
      companyName: input.call.contact.company || 'Unknown company',
      scenario:
        input.call.campaign.prompt ||
        input.call.campaign.objective ||
        'Outbound calling campaign',
      objective:
        input.call.campaign.objective ||
        'Identify interest and capture the next step.',
      selectedLanguage: input.campaignLanguage,
      selectedVoice: input.selectedVoice,
      conversationLanguage: input.conversationLanguage,
      languageInstruction: input.languageInstruction,
    });
  }

  private buildLiveCallingPreUserPrompt(
    call: any,
    ragContext: string,
    idealPath: string,
  ) {
    return buildLiveCallingPreUserPrompt({
      ragContext,
      scenario:
        call.campaign.prompt ||
        call.campaign.objective ||
        'Outbound calling campaign',
      objective:
        call.campaign.objective ||
        'Identify interest and capture the next step.',
      goal:
        call.campaign.botGoal ||
        call.campaign.objective ||
        'Identify interest and capture the next step.',
      idealPath,
      collectedData: this.safeAnalysis(call.analysis)?.collectedData as
        | Record<string, unknown>
        | undefined,
    });
  }

  private buildRacQueryForCall(
    latestUserSpeech: string,
    scripts: Array<Record<string, any>>,
    call?: any,
  ) {
    const latestSpeech = String(latestUserSpeech || '').trim();
    const latestSpeechNormalized = latestSpeech.toLowerCase();
    const recentContactTurns = scripts
      .filter((turn) => turn?.speaker === 'contact')
      .map((turn) => String(turn?.text || '').trim())
      .filter(Boolean)
      .slice(-this.getRacContactTurnLimit())
      .filter((turn) => turn.toLowerCase() !== latestSpeechNormalized)
      .join(' ');
    const campaignContext = [
      call?.campaign?.botGoal,
      call?.campaign?.objective,
      call?.campaign?.prompt,
    ]
      .filter(Boolean)
      .join(' ');

    return this.compactModelText(
      [latestSpeech, recentContactTurns, campaignContext]
        .filter(Boolean)
        .join(' ')
        .trim(),
      this.getCallingRacQueryMaxChars(),
    );
  }

  private buildLiveCallingUserPrompt(
    transcript: string,
    latestUserSpeech: string,
  ) {
    return buildConversationUserPrompt(transcript, latestUserSpeech);
  }

  // ---------------------------------------------------------------------------
  // AI turn generation
  // ---------------------------------------------------------------------------

  private async generateNextCallingTurn(
    call: any,
    latestUserSpeech: string,
    scripts: Array<Record<string, any>>,
  ): Promise<ConversationGeneration> {
    const quickLanguage = this.detectConversationLanguage(
      call,
      latestUserSpeech,
      scripts,
    );
    if (
      this.isImmediateEndSpeech(latestUserSpeech) ||
      this.isPromptExposureRequest(latestUserSpeech)
    ) {
      const botProfile = await this.resolveBotProfile(call.campaign);
      return this.buildFallbackCallingTurn(
        call,
        latestUserSpeech,
        scripts,
        quickLanguage,
        '',
        botProfile,
      );
    }

    const racQuery = this.buildRacQueryForCall(latestUserSpeech, scripts, call);
    const llmScopedScripts = this.getPromptScopedScripts(scripts);
    const [botProfile, conversationLanguage, ragContext] = await Promise.all([
      this.resolveBotProfile(call.campaign),
      Promise.resolve(quickLanguage),
      this.buildCallingRagContext(call, racQuery),
    ]);
    const apiKey = await this.getGeminiApiKey();
    const operationalFallback = this.shouldUseOperationalCallingFallback();
    const fallback = operationalFallback
      ? this.buildOperationalCallingFallback(call, conversationLanguage)
      : this.buildFallbackCallingTurn(
          call,
          latestUserSpeech,
          scripts,
          conversationLanguage,
          ragContext,
          botProfile,
        );
    if (!apiKey) {
      this.logger.warn(
        `Gemini API key is missing for live calling turn generation; using ${operationalFallback ? 'operational' : 'scripted'} fallback response.`,
      );
      return fallback;
    }

    this.logger.debug(
      `Gemini API bot context for call ${call.id}; botName=${botProfile.name}; botRole=${botProfile.role}; knowledgeLength=${String((botProfile.knowledge || '').length)}; ragLength=${String((ragContext || '').length)}; transcriptTurns=${String(scripts.length)}`,
    );

    const transcript = this.scriptsToTranscript(llmScopedScripts);
    const campaignLanguage = conversationLanguage;
    const languageInstruction =
      this.buildLiveCallLanguageInstruction(campaignLanguage);
    const selectedVoice =
      call.selectedVoice ||
      this.resolveGoogleTtsVoice(call.campaign.voice, campaignLanguage);
    const idealPath = this.buildLiveCallIdealPath(call.campaign, botProfile);
    const contactName =
      `${call.contact.firstName || ''} ${call.contact.lastName || ''}`.trim() ||
      'Unknown';
    const AI_EXAMINER_SYSTEM_PROMPT = this.buildLiveCallingAgentPrompt({
      botProfile,
      call,
      contactName,
      campaignLanguage,
      selectedVoice,
      conversationLanguage,
      languageInstruction,
    });
    const PRE_USER_PROMPT = this.buildLiveCallingPreUserPrompt(
      call,
      ragContext,
      idealPath,
    );
    const USER_PROMPT = this.buildLiveCallingUserPrompt(
      transcript,
      latestUserSpeech,
    );

    // FIX 5: Each model attempt gets its own AbortController and timeout so that
    // a slow or aborted first attempt does not cancel subsequent model retries.
    try {
      const configuredModel =
        this.configService.get<string>('GEMINI_LIVE_TURN_MODEL')?.trim() ||
        this.configService.get<string>('GEMINI_CHAT_MODEL')?.trim() ||
        this.configService.get<string>('VERTEX_AI_MODEL')?.trim() ||
        this.configService.get<string>('GOOGLE_VERTEX_MODEL')?.trim() ||
        '';
      const defaultModels = this.getDefaultGeminiTextModels();
      const candidateModels = [
        ...(configuredModel ? [configuredModel] : []),
        ...defaultModels,
      ].filter(Boolean);
      const uniqueModels = Array.from(new Set(candidateModels)).slice(
        0,
        this.getMaxGeminiLiveCallModels(),
      );
      let lastFailureReason = 'unknown error';
      const geminiTwilioTimeoutMs = this.getGeminiTwilioTimeoutMs();

      for (const model of uniqueModels) {
        // FIX 5: Fresh controller per model so a previous timeout/abort does not
        // immediately cancel the next model's fetch.
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          geminiTwilioTimeoutMs,
        );

        try {
          const response = await fetch(
            this.buildGeminiActionUrl(model, 'generateContent', apiKey),
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              signal: controller.signal,
              body: JSON.stringify({
                systemInstruction: {
                  parts: [{ text: AI_EXAMINER_SYSTEM_PROMPT }],
                },
                contents: [
                  {
                    role: 'user',
                    parts: [{ text: `${PRE_USER_PROMPT}\n\n${USER_PROMPT}` }],
                  },
                ],
                generationConfig: {
                  temperature: 0.4,
                  maxOutputTokens: 400,
                  responseMimeType: 'application/json',
                },
              }),
            },
          );
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            lastFailureReason =
              data?.error?.message || response.statusText || 'request failed';
            this.logger.warn(
              `Gemini API model ${model} returned ${response.status || 'error'} for live calling turn: ${lastFailureReason}`,
            );
            continue;
          }
          const content = data?.candidates?.[0]?.content?.parts
            ?.map((part: any) =>
              typeof part?.text === 'string' ? part.text : '',
            )
            .join('\n')
            .trim();
          if (!content) {
            lastFailureReason = 'empty model response';
            continue;
          }
          const parsedContent = this.parseJsonObject(content);
          if (
            !parsedContent ||
            typeof parsedContent.reply !== 'string' ||
            !parsedContent.reply.trim()
          ) {
            lastFailureReason = 'invalid JSON response or missing reply';
            continue;
          }
          return this.normalizeConversationGeneration(
            parsedContent,
            fallback,
            llmScopedScripts,
          );
        } catch (modelErr) {
          // Catch per-model errors (including AbortError) so the loop continues.
          const reason =
            modelErr instanceof Error && modelErr.name === 'AbortError'
              ? `timed out after ${geminiTwilioTimeoutMs}ms`
              : modelErr instanceof Error
                ? modelErr.message
                : String(modelErr);
          lastFailureReason = reason;
          this.logger.warn(
            `Gemini API model ${model} failed for live calling turn: ${reason}`,
          );
        } finally {
          clearTimeout(timeout);
        }
      }

      this.logger.warn(
        `Gemini API live calling turn generation failed; using ${operationalFallback ? 'operational' : 'scripted'} fallback response. Reason: ${lastFailureReason}`,
      );
      return fallback;
    } catch (error) {
      this.logger.warn(
        `Gemini API live calling turn generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  private normalizeConversationGeneration(
    value: any,
    fallback: ConversationGeneration,
    scripts: Array<Record<string, any>>,
  ): ConversationGeneration {
    return normalizeAgentConversationGeneration(
      value,
      fallback,
      scripts as AgentScriptTurn[],
    );
  }

  private shouldEndConversationNow(
    latestUserSpeech: string,
    generation: ConversationGeneration,
  ) {
    // Strict end gate: only end when the contact declines or the configured goal is met.
    if (this.isImmediateEndSpeech(latestUserSpeech)) return true;
    if (this.isLikelyContinuationTurn(latestUserSpeech)) return false;
    return this.isGoalMarkedAsMet(generation);
  }

  private isLikelyContinuationTurn(latestUserSpeech: string) {
    const speech = String(latestUserSpeech || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!speech) return false;
    if (/[?؟]/.test(speech)) return true;
    if (
      /\b(what|how|when|where|which|can you|could you|tell me|share|explain|details|capabilities|price|pricing|cost|more)\b/.test(
        speech,
      )
    ) {
      return true;
    }
    return /\b(next|continue|go on|tell me more|anything else)\b/.test(speech);
  }

  private isGoalMarkedAsMet(generation: ConversationGeneration) {
    const data = generation.collectedData || {};
    const readString = (value: unknown) =>
      typeof value === 'string' ? value : '';

    const goalMetFlag =
      (typeof data.goalMet === 'boolean' && data.goalMet) ||
      (typeof data.objectiveMet === 'boolean' && data.objectiveMet);
    const goalStatus = readString(data.goalStatus).toLowerCase().trim();
    const goalStatusMet = [
      'met',
      'achieved',
      'completed',
      'done',
      'resolved',
    ].includes(goalStatus);
    if (!goalMetFlag && !goalStatusMet) return false;

    const requestedNextStep = readString(data.requestedNextStep)
      .toLowerCase()
      .trim();
    if (
      [
        'callback',
        'details',
        'meeting',
        'booking',
        'handoff',
        'opt_out',
      ].includes(requestedNextStep)
    ) {
      return true;
    }
    if (requestedNextStep === 'none') return false;

    const notes = readString(data.notes).toLowerCase();
    return /\b(callback|follow[- ]?up|send|meeting|book|handoff|opt[- ]?out)\b/.test(
      notes,
    );
  }

  private derivePrimaryGoal(call?: any, botProfile?: any) {
    return String(
      botProfile?.goal ||
        call?.campaign?.botGoal ||
        call?.campaign?.objective ||
        '',
    )
      .replace(/\s+/g, ' ')
      .trim();
  }

  private buildGoalCompletionEndReason(
    call: any,
    botProfile: any,
    latestUserSpeech: string,
  ) {
    if (this.isImmediateEndSpeech(latestUserSpeech)) {
      return 'The contact declined to continue or asked to end the call.';
    }
    const goal = this.derivePrimaryGoal(call, botProfile);
    if (!goal) return 'The primary conversation goal was achieved.';
    return `The primary conversation goal was achieved: ${goal}.`;
  }

  private buildLiveTurnFallback(
    call: any,
    latestUserSpeech: string,
    scripts: Array<Record<string, any>>,
    conversationLanguage: string,
    botProfile: any,
  ) {
    if (this.shouldUseOperationalCallingFallback()) {
      return this.buildOperationalCallingFallback(call, conversationLanguage);
    }

    return this.buildFallbackCallingTurn(
      call,
      latestUserSpeech,
      scripts,
      conversationLanguage,
      '',
      botProfile,
    );
  }

  private shouldUseOperationalCallingFallback() {
    return this.isGeminiLiveCallingMode() && !this.allowsTwilioGatherFallback();
  }

  private buildOperationalCallingFallback(
    call: any,
    conversationLanguage?: string,
  ): ConversationGeneration {
    const language = this.normalizeLanguageCode(conversationLanguage);
    const reply = this.isHindiLanguage(language)
      ? 'माफ़ कीजिए, अभी हमारी लाइव वॉइस कनेक्शन में तकनीकी समस्या आ रही है. मैं कॉल यहीं समाप्त कर रहा हूँ, टीम आपसे बाद में संपर्क करेगी.'
      : "Sorry, I'm having a live voice connection issue right now. I'll end the call here and have the team follow up with you.";

    return {
      reply,
      shouldEnd: true,
      endReason: 'Gemini Live was unavailable during the call.',
      collectedData: {
        goalStatus: 'not_possible',
        requestedNextStep: 'handoff',
        technicalIssue: 'gemini_live_unavailable',
      },
      sentimentScore: 5,
      keyOutcomes: 'Call ended because Gemini Live was unavailable.',
      topicsCovered: this.buildTopicsCovered(
        call.campaign,
        this.buildBotProfile(call.campaign),
      ),
    };
  }

  private buildFallbackCallingTurn(
    call: any,
    latestUserSpeech: string,
    scripts: Array<Record<string, any>>,
    conversationLanguage?: string,
    ragContext = '',
    botProfileOverride?: any,
  ): ConversationGeneration {
    const botProfile =
      botProfileOverride || this.buildBotProfile(call.campaign);
    const userTurns = this.countScriptTurns(scripts, 'contact');
    const lower = latestUserSpeech.toLowerCase();
    const topicsCovered = this.buildTopicsCovered(call.campaign, botProfile);
    const language = this.normalizeLanguageCode(conversationLanguage);

    if (this.isImmediateEndSpeech(latestUserSpeech)) {
      return {
        reply:
          lower.includes('wrong number') || lower.includes('not interested')
            ? this.isHindiLanguage(language)
              ? 'समझ गया. मैं आपका समय और नहीं लूँगा. धन्यवाद, आपका दिन शुभ हो.'
              : 'Understood. I will not take more of your time. Thank you, and have a good day.'
            : this.isHindiLanguage(language)
              ? 'समझ गया. मैं इसे नोट कर दूँगा और टीम को बता दूँगा. नमस्ते.'
              : 'Thanks for your time. I will note that and let the team know. Goodbye.',
        shouldEnd: true,
        endReason:
          'The contact declined, ended the call, or indicated a wrong number.',
        collectedData: { latestUserSpeech },
        sentimentScore: lower.includes('not interested') ? 4 : 6,
        keyOutcomes: 'Contact ended or declined the conversation.',
        topicsCovered,
      };
    }

    const reply = this.buildRoleAwareFallbackReply(
      call,
      botProfile,
      userTurns,
      latestUserSpeech,
      language,
      ragContext,
      scripts,
    );

    return {
      reply: this.compactForSpeech(reply, 240),
      shouldEnd: false,
      endReason: '',
      collectedData: { latestUserSpeech, goalStatus: 'pending' },
      sentimentScore: 7,
      keyOutcomes: 'Live conversation is in progress.',
      topicsCovered,
    };
  }

  private isImmediateEndSpeech(value: string) {
    if (!this.immediateEndPatternCache) {
      this.immediateEndPatternCache = buildKeywordRegex(
        readStringListConfig(
          this.configService,
          'AI_CALLING_IMMEDIATE_END_TERMS',
          DEFAULT_IMMEDIATE_END_TERMS,
        ),
      );
    }
    return this.immediateEndPatternCache.test(value);
  }

  private isPromptExposureRequest(value: string) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!text) return false;
    const directLeakIntentPattern =
      /\b(show|share|reveal|tell|disclose|give|print|repeat|read|what(?:'s| is))\b[\s\S]{0,60}\b(system prompt|prompt|instructions?|rules?|developer message|hidden instructions?)\b|\b(ignore previous instructions|jailbreak|reveal your rules|show your rules|system prompt|developer message)\b/i;
    if (directLeakIntentPattern.test(text)) return true;

    const terms = this.getPromptExposureTerms();
    const matchedTerms = terms.filter((term) =>
      text.includes(term.toLowerCase()),
    );
    if (matchedTerms.length >= 2) return true;
    if (matchedTerms.length === 0) return false;

    const onlyTerm = matchedTerms[0].toLowerCase();
    if (onlyTerm === 'prompt' || onlyTerm === 'instructions') {
      return /\b(show|share|reveal|tell|disclose|give|read|what(?:'s| is))\b/.test(
        text,
      );
    }
    return true;
  }

  private getPromptExposureTerms(): string[] {
    if (!this.promptExposureTermsCache) {
      this.promptExposureTermsCache = readStringListConfig(
        this.configService,
        'AI_CALLING_PROMPT_EXPOSURE_TERMS',
        DEFAULT_PROMPT_EXPOSURE_TERMS,
      )
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean);
    }
    return this.promptExposureTermsCache || [];
  }

  private buildLiveCallLanguageInstruction(language?: string) {
    const normalized = this.normalizeLanguageCode(language);
    if (normalized === 'hi-IN') {
      return 'You MUST speak and reply ONLY in Hindi (using Devanagari script). Keep the Hindi natural, polite, and conversational, like a real person calling.';
    }
    if (normalized === 'en-IN') {
      return 'You MUST speak and reply in Indian English. Use concise, professional Indian English phrasing and a natural Indian phone-call style while keeping the text understandable internationally.';
    }
    if (normalized === 'en-US') {
      return 'You MUST speak and reply in American English. Use concise, professional American phone-call phrasing and a natural phone-call style.';
    }
    if (normalized) {
      return `You MUST speak and reply in ${normalized}. Keep it natural, polite, and conversational, like a real person calling.`;
    }
    return 'You MUST speak and reply in the campaign language. Keep it natural, polite, and conversational, like a real person calling.';
  }

  private detectConversationLanguage(
    call: any,
    latestUserSpeech: string,
    scripts: Array<Record<string, any>>,
  ) {
    if (call?.selectedLanguage || call?.selectedVoice) {
      return this.resolveCallSelectedVoiceConfig(call).language;
    }

    const currentLanguage = this.normalizeLanguageCode(
      call?.campaign?.language,
    );
    if (currentLanguage === 'hi-IN') {
      return 'hi-IN';
    }

    const combinedSpeech = [
      latestUserSpeech,
      ...scripts.map((turn) => turn?.text || ''),
    ]
      .join(' ')
      .trim();
    if (this.containsHindiScript(combinedSpeech)) {
      return 'hi-IN';
    }
    if (this.looksLikeRomanizedHindi(combinedSpeech)) {
      return 'hi-IN';
    }

    return (
      currentLanguage ||
      this.resolveGoogleVoiceLanguage(
        call?.campaign?.language,
        call?.campaign?.voice,
      )
    );
  }

  private containsHindiScript(value?: string) {
    return /[\u0900-\u097F]/.test(value || '');
  }

  private looksLikeRomanizedHindi(value?: string) {
    const text = (value || '').toLowerCase();
    const cues = [
      /\b(kya|kyun|kaise|kaisa|kaisi|nahi|nahin|haan|ji|mera|meri|mere|aap|mujhe|batao|kripya|dhanyavaad|thik|theek|abhi|baad|kal|aaj|koi|kuch)\b/g,
      /\b(haanji|sahi|zaroor|jaroor|bilkul|shayad|madad|samajh|samjha)\b/g,
    ];
    const matches = cues.reduce((total, pattern) => {
      const found = text.match(pattern);
      return total + (found?.length || 0);
    }, 0);
    return matches >= 2;
  }

  private isHindiLanguage(language?: string) {
    return this.normalizeLanguageCode(language) === 'hi-IN';
  }

  private async completeTwilioConversation(
    call: any,
    scripts: Array<Record<string, any>>,
    generation: ConversationGeneration,
  ) {
    const endedAt = new Date();
    const startedAt = call.startedAt ? new Date(call.startedAt) : endedAt;
    const botProfile = await this.resolveBotProfile(call.campaign);
    await this.db.callHistory.update({
      where: { id: call.id },
      data: {
        status: 'COMPLETED',
        outcome: 'ANSWERED',
        sessionStatus: 'completed',
        scripts,
        transcript: this.scriptsToTranscript(scripts),
        summary: `${botProfile.name} completed the AI calling conversation with ${call.contact.firstName || 'the contact'}.`,
        sentimentScore: generation.sentimentScore,
        keyOutcomes: generation.keyOutcomes,
        // FIX 4: Use safeAnalysis() to prevent spreading a non-object JSON value.
        analysis: {
          ...this.safeAnalysis(call.analysis),
          collectedData: generation.collectedData,
          finalDecision: {
            shouldEnd: generation.shouldEnd,
            endReason: generation.endReason,
          },
        },
        topicsCovered: generation.topicsCovered,
        endCallReason: generation.endReason || 'Conversation ended naturally.',
        endedAt,
        totalTime: endedAt.getTime() - startedAt.getTime(),
        timestamp: new Date(),
      },
    });
    this.logger.debug(
      `Twilio final transcription for call ${call.id}; userBotTranscript=${JSON.stringify(this.scriptsToTranscript(scripts))}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Analysis / metadata builders
  // ---------------------------------------------------------------------------

  private buildCallAnalysis(
    campaign: any,
    contact: any,
    botProfile: any,
    sentimentScore: number,
  ) {
    const objective = campaign.objective || 'campaign follow-up';
    const topicsCovered = this.buildTopicsCovered(campaign, botProfile);

    return {
      engagement_score: Math.round(sentimentScore * 10),
      intent: 'interested_follow_up',
      contactName:
        `${contact.firstName || ''} ${contact.lastName || ''}`.trim(),
      agentPersona: {
        name: botProfile.name,
        role: botProfile.role,
        personality: botProfile.personality,
      },
      objective,
      strengths: [
        'Opened with context and permission.',
        'Kept the call concise.',
        'Offered a clear next step.',
      ],
      areasImprove: [
        'Confirm exact callback timing on live calls.',
        'Capture any objection in the CRM notes.',
      ],
      topicsCovered,
      nextBestAction: 'Send details and schedule a follow-up.',
    };
  }

  private buildTopicsCovered(campaign: any, botProfile: any) {
    return [
      campaign.objective ? 'Objective' : '',
      botProfile.knowledge ? 'Knowledge base' : '',
      botProfile.rules ? 'Conversation rules' : '',
      botProfile.objections ? 'Objection handling' : '',
      'Follow-up',
    ].filter(Boolean);
  }

  private buildKeyOutcomes(campaign: any) {
    const objections = campaign.botObjectionHandling?.trim();
    if (objections) {
      return `Captured interest level, handled objections using bot training, and marked contact for follow-up.`;
    }

    return 'Captured interest level and marked contact for follow-up.';
  }

  private applyBotVariables(
    value: string,
    contact: any,
    campaign: any,
    botProfile: any,
  ) {
    const variables: Record<string, string> = {
      firstName: contact.firstName || 'there',
      lastName: contact.lastName || '',
      companyName: contact.company || 'your team',
      contactCompany: contact.company || 'your team',
      botName: botProfile.name,
      botRole: botProfile.role,
      botGoal: botProfile.goal || campaign.botGoal || campaign.objective || '',
      objective: campaign.objective || '',
    };

    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '');
  }

  private getAiCallingMode() {
    return readStringConfig(
      this.configService,
      'AI_CALLING_MODE',
      AI_CALLING_MODE,
    )
      .trim()
      .toLowerCase();
  }

  private isGeminiLiveCallingMode() {
    const mode = this.getAiCallingMode();
    return !['twilio_gather', 'gather', 'legacy'].includes(mode);
  }

  private allowsTwilioGatherFallback() {
    return readBooleanConfig(
      this.configService,
      'AI_CALLING_ALLOW_TWILIO_GATHER_FALLBACK',
      AI_CALLING_ALLOW_TWILIO_GATHER_FALLBACK,
    );
  }

  private async assertGeminiLiveReadyBeforeCalling(campaignId: string) {
    if (!this.isGeminiLiveCallingMode()) return;

    try {
      this.logger.log(
        `Initializing Gemini Live before dialing campaign ${campaignId}`,
      );
      await this.geminiLiveService.initializeForLaunch();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (this.allowsTwilioGatherFallback()) {
        this.logger.warn(
          `Gemini Live preflight failed for campaign ${campaignId}; continuing because AI_CALLING_ALLOW_TWILIO_GATHER_FALLBACK is enabled. Reason: ${reason}`,
        );
        return;
      }

      this.logger.warn(
        `Gemini Live preflight blocked campaign ${campaignId}: ${reason}`,
      );
      throw new BadRequestException(
        `Gemini Live is not ready: ${reason}. AI calling was not started.`,
      );
    }
  }

  private getDefaultGeminiTextModels() {
    const legacyVertexModels = readStringListConfig(
      this.configService,
      'VERTEX_FALLBACK_MODELS',
      DEFAULT_GEMINI_TEXT_MODELS,
    );
    return readStringListConfig(
      this.configService,
      'GEMINI_FALLBACK_MODELS',
      legacyVertexModels,
    );
  }

  private getMaxGeminiLiveCallModels() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'MAX_GEMINI_LIVE_CALL_MODELS',
        readNumberConfig(
          this.configService,
          'MAX_VERTEX_LIVE_CALL_MODELS',
          MAX_GEMINI_LIVE_CALL_MODELS,
          1,
          5,
        ),
        1,
        5,
      ),
    );
  }

  private getTwilioResponseBudgetMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'TWILIO_RESPONSE_BUDGET_MS',
        TWILIO_RESPONSE_BUDGET_MS,
        1000,
        20000,
      ),
    );
  }

  private getTwilioSpeechTimeoutSeconds() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'TWILIO_SPEECH_TIMEOUT_SECONDS',
        TWILIO_SPEECH_TIMEOUT_SECONDS,
        1,
        5,
      ),
    );
  }

  private isTwilioHdPlayEnabled() {
    return readBooleanConfig(
      this.configService,
      'TWILIO_HD_PLAY_ENABLED',
      TWILIO_HD_PLAY_ENABLED,
    );
  }

  private getGoogleTtsTimeoutMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'GOOGLE_TTS_TIMEOUT_MS',
        GOOGLE_TTS_TIMEOUT_MS,
        500,
        30000,
      ),
    );
  }

  private getGeminiTwilioTimeoutMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'GEMINI_TWILIO_TIMEOUT_MS',
        readNumberConfig(
          this.configService,
          'VERTEX_TWILIO_TIMEOUT_MS',
          GEMINI_TWILIO_TIMEOUT_MS,
          500,
          30000,
        ),
        500,
        30000,
      ),
    );
  }

  private getRacContactTurnLimit() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'AI_CALLING_RAC_CONTACT_TURN_LIMIT',
        3,
        1,
        10,
      ),
    );
  }

  private getCallingPromptScriptTurnLimit() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'AI_CALLING_PROMPT_SCRIPT_TURNS',
        DEFAULT_LIVE_PROMPT_SCRIPT_TURNS,
        6,
        40,
      ),
    );
  }

  private getCallingRacQueryMaxChars() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'AI_CALLING_RAC_QUERY_MAX_CHARS',
        DEFAULT_LIVE_RAC_QUERY_CHARS,
        300,
        4000,
      ),
    );
  }

  private getCallingRacTopK() {
    return Math.floor(
      readNumberConfig(this.configService, 'AI_CALLING_RAC_TOP_K', 4, 1, 8),
    );
  }

  // ---------------------------------------------------------------------------
  // Text utilities
  // ---------------------------------------------------------------------------

  private sentenceFromText(value?: string) {
    const text = value?.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const shortened = text.length > 260 ? `${text.slice(0, 257)}...` : text;
    return /[.!?]$/.test(shortened) ? shortened : `${shortened}.`;
  }

  private firstSentence(value?: string) {
    const text = value?.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.match(/^[^.!?]+[.!?]?/)?.[0]?.trim() || text;
  }

  private compactForSpeech(value: string, maxLength = 260) {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= maxLength) return text;
    const shortened = text.slice(0, maxLength - 3);
    const sentenceEnd = Math.max(
      shortened.lastIndexOf('.'),
      shortened.lastIndexOf('?'),
      shortened.lastIndexOf('!'),
    );
    if (sentenceEnd > 80) return shortened.slice(0, sentenceEnd + 1);
    const space = shortened.lastIndexOf(' ');
    return `${shortened.slice(0, space > 80 ? space : maxLength - 3)}...`;
  }

  private compactModelText(value: string, maxLength: number) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length <= maxLength) return text;
    const shortened = text.slice(0, maxLength - 3);
    const splitAt = Math.max(
      shortened.lastIndexOf('. '),
      shortened.lastIndexOf(' '),
    );
    return `${shortened
      .slice(0, splitAt > 80 ? splitAt : maxLength - 3)
      .trim()}...`;
  }

  private stripSentenceEnding(value: string) {
    return value.replace(/(\.\.\.|[.!?])+$/g, '').trim();
  }

  // ---------------------------------------------------------------------------
  // Language / voice resolution
  // ---------------------------------------------------------------------------

  private normalizeLanguageCode(language?: string) {
    const normalized = language?.trim();
    if (normalized === 'hi') return 'hi-IN';
    if (normalized === 'en') return 'en-US';
    return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(normalized || '')
      ? normalized
      : undefined;
  }

  private buildCallSpeechCampaign(call: any) {
    const campaign = call?.campaign || {};
    const { language, voice } = this.resolveCallSelectedVoiceConfig(call);
    return { ...campaign, language, voice };
  }

  private resolveCallSelectedVoiceConfig(call: any) {
    const campaign = call?.campaign || {};
    const selectedLanguage = this.normalizeLanguageCode(call?.selectedLanguage);
    const selectedVoice =
      typeof call?.selectedVoice === 'string' ? call.selectedVoice.trim() : '';
    if (selectedLanguage || selectedVoice) {
      const selectedVoiceLanguage =
        this.extractExplicitLanguageFromVoice(selectedVoice);
      const language = this.resolveGoogleVoiceLanguage(
        selectedLanguage || selectedVoiceLanguage || campaign.language,
        selectedVoice || campaign.voice,
      );
      return {
        language,
        voice:
          selectedVoice || this.resolveGoogleTtsVoice(campaign.voice, language),
      };
    }

    const language = this.resolveGoogleVoiceLanguage(
      campaign.language,
      campaign.voice,
    );
    return {
      language,
      voice: this.resolveGoogleTtsVoice(campaign.voice, language),
    };
  }

  private extractExplicitLanguageFromVoice(voice?: string) {
    const normalized = voice?.trim();
    if (!normalized) return undefined;
    if (/hi-IN/i.test(normalized)) return 'hi-IN';
    if (/en-US/i.test(normalized)) return 'en-US';
    if (/en-IN/i.test(normalized)) return 'en-IN';
    return undefined;
  }

  private buildSayAttributes(voice?: string, language?: string) {
    const attributes = [];
    if (voice) {
      attributes.push(` voice="${this.escapeXml(voice)}"`);
    }
    if (language) {
      attributes.push(` language="${this.escapeXml(language)}"`);
    }
    return attributes.length ? attributes.join('') : '';
  }

  private resolveTwilioGatherLanguage(language?: string) {
    const normalized = this.normalizeLanguageCode(language);
    if (!normalized) return undefined;

    // Twilio STT does not support en-IN natively; map to en-US.
    if (normalized === 'en-IN') {
      return 'en-US';
    }

    return normalized;
  }

  private normalizeCampaignVoice(voice?: string, language?: string) {
    const normalized = voice?.trim();
    const withoutProvider = normalized?.replace(/^google:/i, '');
    if (normalized) {
      const voiceName = this.extractGeminiVoiceName(withoutProvider);
      return `google:${this.resolveGoogleVoiceLanguage(language, withoutProvider)}-Chirp3-HD-${voiceName}`;
    }

    const profiles = this.aiCallingBotsService?.getGoogleVoiceProfiles() || [];
    const byLanguage = profiles.find(
      (profile) => profile.language === this.normalizeLanguageCode(language),
    );
    if (byLanguage) return byLanguage.voice;

    if (normalized?.toLowerCase().includes('hi')) {
      return 'google:hi-IN-Chirp3-HD-Puck';
    }
    if (this.normalizeLanguageCode(language) === 'en-US') {
      return 'google:en-US-Chirp3-HD-Puck';
    }
    return 'google:en-IN-Chirp3-HD-Puck';
  }

  private inferLanguageFromVoice(voice?: string) {
    const normalized = voice?.trim();
    if (normalized?.includes('hi-IN')) return 'hi-IN';
    if (normalized?.includes('en-US')) return 'en-US';
    if (normalized?.includes('en-IN')) return 'en-IN';
    return 'en-IN';
  }

  private resolveGoogleTtsVoice(voice?: string, language?: string) {
    const normalizedVoice = voice?.trim() || '';
    const withoutProvider = normalizedVoice.startsWith('google:')
      ? normalizedVoice.slice('google:'.length)
      : normalizedVoice;

    const voiceName = this.extractGeminiVoiceName(withoutProvider);
    return `${this.resolveGoogleVoiceLanguage(language, withoutProvider)}-Chirp3-HD-${voiceName}`;
  }

  private resolveGoogleVoiceLanguage(language?: string, voice?: string) {
    return (
      this.normalizeLanguageCode(language) ||
      this.inferLanguageFromVoice(voice) ||
      'en-IN'
    );
  }

  private extractGeminiVoiceName(value?: string) {
    const supported = new Set([
      'Puck',
      'Charon',
      'Kore',
      'Fenrir',
      'Aoede',
      'Zephyr',
      'Orus',
      'Autonoe',
      'Umbriel',
      'Erinome',
      'Laomedeia',
      'Schedar',
      'Achird',
      'Sadachbia',
      'Enceladus',
      'Algieba',
      'Algenib',
      'Achernar',
      'Gacrux',
      'Zubenelgenubi',
      'Sadaltager',
      'Leda',
      'Callirrhoe',
      'Iapetus',
      'Despina',
      'Rasalgethi',
      'Alnilam',
      'Pulcherrima',
      'Vindemiatrix',
      'Sulafat',
    ]);
    const last = value?.split('-').at(-1)?.split(':').at(-1) || 'Puck';
    const normalized = `${last.charAt(0).toUpperCase()}${last
      .slice(1)
      .toLowerCase()}`;
    return supported.has(normalized) ? normalized : 'Puck';
  }

  private resolveTwilioVoice(voice?: string, language?: string) {
    const googleVoice = this.resolveGoogleTtsVoice(voice, language);
    const voiceName = this.extractGeminiVoiceName(googleVoice);

    if (googleVoice.startsWith('hi-IN')) return 'Google.hi-IN-Neural2-C';
    if (googleVoice.startsWith('en-US')) {
      return voiceName === 'Kore' || voiceName === 'Aoede'
        ? 'Google.en-US-Neural2-F'
        : 'Google.en-US-Neural2-D';
    }
    return voiceName === 'Kore' || voiceName === 'Aoede'
      ? 'Google.en-IN-Wavenet-A'
      : 'Google.en-IN-Wavenet-D';
  }

  private async getGoogleTtsAccessToken() {
    return '';
  }

  private async getGeminiApiKey() {
    const savedKey = await this.getSavedGeminiApiKey();
    return (
      savedKey ||
      this.configService?.get<string>('GEMINI_API_KEY')?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      ''
    );
  }

  private async getSavedGeminiApiKey() {
    try {
      const settings = decryptSystemSettings(
        await this.db.systemSettings.findUnique({
          where: { id: 'default' },
          select: { geminiApiKey: true },
        }),
      );
      return settings?.geminiApiKey?.trim() || '';
    } catch (error) {
      this.logger.warn(
        `Could not read saved Gemini API key: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }

  private buildGeminiActionUrl(
    model: string,
    action: 'generateContent',
    apiKey: string,
  ) {
    const normalizedModel = String(model || '')
      .trim()
      .replace(/^models\//, '');
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}:${action}?key=${encodeURIComponent(apiKey)}`;
  }

  // ---------------------------------------------------------------------------
  // Misc utilities
  // ---------------------------------------------------------------------------

  /**
   * FIX 4 & 8: Safely coerce a Prisma JSON field value to a plain object.
   * Prisma JSON fields can be null, a primitive, or an array depending on what
   * was previously stored. Spreading a non-object crashes at runtime.
   */
  private safeAnalysis(value: unknown): Record<string, unknown> {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private escapeXml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private hasCallablePhone(contact: any) {
    return Boolean(contact?.phoneNumber?.trim());
  }

  private maskPhoneNumber(phoneNumber?: string) {
    const digits = phoneNumber?.replace(/\D/g, '') || '';
    if (digits.length <= 4) return phoneNumber || 'missing';
    return `${phoneNumber?.startsWith('+') ? '+' : ''}***${digits.slice(-4)}`;
  }

  private getPromptScopedScripts(scripts: Array<Record<string, any>>) {
    return scripts.slice(-this.getCallingPromptScriptTurnLimit());
  }

  private async buildCallingRagContext(call: any, query: string) {
    const aiCallingBotId = String(call?.campaign?.aiCallingBotId || '').trim();
    if (!aiCallingBotId || !query) return '';
    try {
      return await this.aiCallingBotsService.buildCallingContext(
        aiCallingBotId,
        query,
        this.getCallingRacTopK(),
      );
    } catch (error) {
      this.logger.warn(
        `RAG context fetch failed for bot ${aiCallingBotId}; continuing without RAG context. Reason: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }
}
