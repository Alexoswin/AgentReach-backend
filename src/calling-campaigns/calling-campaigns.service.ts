import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { BotService } from '../bot/bot.service';
import { normalizeResponseSpeed } from '../realtime-calling/response-speed';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';
import { GenerateCallingCampaignDto } from './dto/generate-calling-campaign.dto';

type GenerationJob = {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: Record<string, unknown>;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
};

const ACTIVE_OUTCOMES = new Set([
  'PENDING',
  'QUEUING',
  'QUEUED',
  'DIALING',
  'RINGING',
  'CONNECTED',
  'IN_PROGRESS',
]);

@Injectable()
export class CallingCampaignsService {
  private readonly logger = new Logger(CallingCampaignsService.name);
  private readonly generationJobs = new Map<string, GenerationJob>();

  constructor(
    private readonly db: MongoService,
    private readonly settingsService: SettingsService,
    private readonly botService: BotService,
    private readonly configService: ConfigService,
  ) {}

  async findAll() {
    const campaigns = await this.db.callingCampaign.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(campaigns.map((campaign: any) => this.withCounts(campaign)));
  }

  async findOne(id: string) {
    const campaign = await this.db.callingCampaign.findUnique({
      where: { id },
      include: {
        calls: {
          include: { contact: true },
        },
      },
    });
    if (!campaign) throw new BadRequestException('Calling campaign not found.');
    return this.withCounts(campaign);
  }

  async create(dto: CreateCallingCampaignDto) {
    const botDefaults = dto.aiCallingBotId
      ? await this.botService.getCampaignDefaults(dto.aiCallingBotId)
      : {};
    const data = this.normalizeCampaignPayload({
      ...botDefaults,
      ...dto,
      status: 'DRAFT',
    });
    const campaign = await this.db.callingCampaign.create({ data });
    await this.addCallableContacts(campaign.id, dto.contactIds || [], data);
    return this.findOne(campaign.id);
  }

  async update(
    id: string,
    dto: Partial<CreateCallingCampaignDto> & { status?: string },
  ) {
    await this.findOne(id);
    const { contactIds, ...campaignFields } = dto;
    if (Object.keys(campaignFields).length > 0) {
      await this.db.callingCampaign.update({
        where: { id },
        data: this.normalizeCampaignPayload(campaignFields),
      });
    }
    if (contactIds?.length) {
      const campaign = await this.db.callingCampaign.findUnique({ where: { id } });
      await this.addCallableContacts(id, contactIds, campaign || {});
    }
    return this.findOne(id);
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.db.callHistory.deleteMany({ where: { campaignId: id } });
    return this.db.callingCampaign.delete({ where: { id } });
  }

  async launchCampaign(id: string) {
    return this.launch(id, false);
  }

  async relaunchCampaign(id: string) {
    return this.launch(id, true);
  }

  async stopCampaign(id: string) {
    const campaign = await this.findOne(id);
    const settings = await this.settingsService.getRawSettings();
    let cancelledCalls = 0;

    for (const call of campaign.calls || []) {
      if (!ACTIVE_OUTCOMES.has(String(call.outcome || '').toUpperCase())) {
        continue;
      }
      if (
        call.providerCallSid &&
        !this.isMockTwilio(settings) &&
        settings?.twilioAccountSid &&
        settings?.twilioAuthToken
      ) {
        await this.cancelTwilioCall(settings, call.providerCallSid).catch(
          (error) => this.logger.warn(error?.message || error),
        );
      }
      await this.db.callHistory.update({
        where: { id: call.id },
        data: {
          status: 'CANCELLED',
          outcome: 'CANCELLED',
          sessionStatus: 'cancelled',
          providerStatus: 'cancelled',
          endedAt: new Date(),
          endCallReason: 'campaign_stopped',
        },
      });
      cancelledCalls++;
    }

    await this.db.callingCampaign.update({
      where: { id },
      data: { status: 'STOPPED', stoppedAt: new Date() },
    });

    return { status: 'STOPPED', cancelledCalls };
  }

  async getDashboardMetrics() {
    const campaigns = await this.db.callingCampaign.findMany();
    const calls = await this.db.callHistory.findMany();
    const answered = calls.filter((call: any) => call.outcome === 'ANSWERED');
    const failed = calls.filter((call: any) => call.outcome === 'FAILED');
    return {
      totalCampaigns: campaigns.length,
      activeCampaigns: campaigns.filter((campaign: any) =>
        ['LAUNCHING', 'RUNNING'].includes(campaign.status),
      ).length,
      totalCalls: calls.length,
      answeredCalls: answered.length,
      failedCalls: failed.length,
      averageDuration: answered.length
        ? Math.round(
            answered.reduce(
              (total: number, call: any) => total + Number(call.duration || 0),
              0,
            ) / answered.length,
          )
        : 0,
    };
  }

  async generateCampaign(dto: GenerateCallingCampaignDto) {
    return this.buildGeneratedCampaign(dto);
  }

  async startGenerate(dto: GenerateCallingCampaignDto) {
    const now = new Date();
    const job: GenerationJob = {
      id: randomUUID(),
      status: 'PROCESSING',
      createdAt: now,
      updatedAt: now,
    };
    this.generationJobs.set(job.id, job);

    try {
      job.result = await this.buildGeneratedCampaign(dto);
      job.status = 'COMPLETED';
    } catch (error: any) {
      job.status = 'FAILED';
      job.error = error?.message || 'Generation failed.';
    } finally {
      job.updatedAt = new Date();
      this.generationJobs.set(job.id, job);
    }

    return job;
  }

  generationStatus(id: string) {
    const job = this.generationJobs.get(id);
    if (!job) throw new BadRequestException('Generation job not found.');
    return job;
  }

  async handleTwilioAnswer(callId: string, body: any) {
    const call = await this.db.callHistory.findUnique({
      where: { id: callId },
      include: { campaign: true },
    });
    if (!call) return this.twimlResponse('<Hangup/>');

    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        provider: 'twilio',
        providerCallSid: body?.CallSid || call.providerCallSid,
        providerStatus: 'in-progress',
        status: 'IN_PROGRESS',
        outcome: 'IN_PROGRESS',
        sessionStatus: 'in_progress',
        startedAt: call.startedAt || new Date(),
        connectedAt: call.connectedAt || new Date(),
      },
    });

    const streamUrl = `${this.getPublicWsBaseUrl()}/twilio/stream`;
    return this.twimlResponse(
      `<Connect><Stream url="${this.xml(streamUrl)}"><Parameter name="callId" value="${this.xml(
        callId,
      )}"/><Parameter name="campaignId" value="${this.xml(
        call.campaignId,
      )}"/></Stream></Connect>`,
    );
  }

  async handleTwilioResponse(callId: string, _body: any) {
    await this.db.callHistory.update({
      where: { id: callId },
      data: { providerStatus: 'respond_compat_noop' },
    }).catch(() => undefined);
    return this.twimlResponse('');
  }

  async handleTwilioStatus(callId: string, body: any) {
    const status = String(body?.CallStatus || body?.CallStatusCallback || '').toLowerCase();
    const duration = Number(body?.CallDuration || body?.Duration || 0);
    const outcome = this.twilioStatusToOutcome(status, duration);
    const isDone = ['ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED'].includes(
      outcome,
    );

    const call = await this.db.callHistory.findUnique({ where: { id: callId } });
    if (!call) return { ok: true };

    await this.db.callHistory.update({
      where: { id: callId },
      data: {
        provider: 'twilio',
        providerCallSid: body?.CallSid || call.providerCallSid,
        providerStatus: status || body?.CallStatus,
        outcome,
        status: isDone ? 'COMPLETED' : outcome,
        sessionStatus: isDone ? 'completed' : status || 'updated',
        duration: duration || call.duration || 0,
        endedAt: isDone ? new Date() : call.endedAt,
        errorMessage: body?.ErrorMessage || call.errorMessage,
      },
    });

    if (isDone) await this.checkAndCompleteCampaign(call.campaignId);
    return { ok: true };
  }

  async handleTwilioRecording(callId: string, body: any) {
    const recordingUrl = body?.RecordingUrl
      ? `${body.RecordingUrl}${String(body.RecordingUrl).endsWith('.mp3') ? '' : '.mp3'}`
      : undefined;
    if (recordingUrl) {
      await this.db.callHistory.update({
        where: { id: callId },
        data: { recordingUrl },
      }).catch(() => undefined);
    }
    return { ok: true };
  }

  private async launch(id: string, relaunch: boolean) {
    const campaign = await this.findOne(id);
    const settings = await this.settingsService.getRawSettings();
    if (!this.hasTwilioSettings(settings)) {
      throw new BadRequestException(
        'Twilio is not fully configured. Add Account SID, Auth Token, and Phone Number in Settings.',
      );
    }

    let calls = Array.isArray(campaign.calls) ? campaign.calls : [];
    if (relaunch) {
      for (const call of calls) {
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            status: 'PENDING',
            outcome: 'PENDING',
            sessionStatus: 'pending',
            providerStatus: undefined,
            providerCallSid: undefined,
            duration: 0,
            startedAt: undefined,
            connectedAt: undefined,
            endedAt: undefined,
            errorMessage: undefined,
            transcript: undefined,
            scripts: [],
          },
        });
      }
      calls = (await this.findOne(id)).calls || [];
    }

    const callable = calls.filter((call: any) => call.contact?.phoneNumber);
    if (callable.length === 0) {
      throw new BadRequestException(
        'This calling campaign has no contacts with phone numbers.',
      );
    }

    await this.db.callingCampaign.update({
      where: { id },
      data: { status: 'LAUNCHING', lastLaunchedAt: new Date(), stoppedAt: undefined },
    });

    if (this.isMockTwilio(settings)) {
      const result = await this.simulateCalls(id, callable);
      await this.db.callingCampaign.update({
        where: { id },
        data: { status: 'COMPLETED' },
      });
      return result;
    }

    const twilio = { placed: 0, failed: 0, errors: [] as string[] };
    for (const call of callable) {
      try {
        const response = await this.createTwilioCall(settings, call.id, call.contact.phoneNumber);
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            provider: 'twilio',
            providerCallSid: response.sid,
            providerStatus: response.status || 'queued',
            outcome: 'QUEUED',
            status: 'QUEUED',
            sessionStatus: 'queued',
            selectedLanguage: campaign.selectedLanguage || campaign.language,
            selectedVoice: campaign.selectedVoice || campaign.voice,
            startedAt: new Date(),
          },
        });
        twilio.placed++;
      } catch (error: any) {
        const message = error?.message || 'Twilio call creation failed.';
        twilio.failed++;
        twilio.errors.push(message);
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            outcome: 'FAILED',
            status: 'FAILED',
            sessionStatus: 'failed',
            providerStatus: 'failed',
            errorMessage: message,
            endedAt: new Date(),
          },
        });
      }
    }

    await this.db.callingCampaign.update({
      where: { id },
      data: { status: twilio.placed > 0 ? 'RUNNING' : 'FAILED' },
    });

    return { status: twilio.placed > 0 ? 'RUNNING' : 'FAILED', twilio };
  }

  private async simulateCalls(id: string, calls: any[]) {
    for (const call of calls) {
      const endedAt = new Date();
      await this.db.callHistory.update({
        where: { id: call.id },
        data: {
          provider: 'twilio',
          providerCallSid: `mock-${call.id}`,
          providerStatus: 'completed',
          outcome: 'ANSWERED',
          status: 'COMPLETED',
          sessionStatus: 'completed',
          startedAt: new Date(endedAt.getTime() - 30000),
          connectedAt: new Date(endedAt.getTime() - 28000),
          endedAt,
          duration: 30,
          transcript: `AI: ${call.campaign?.botGreeting || 'Hello, this is a quick ReachConvert call.'}\nUser: Mock call completed.`,
          scripts: [
            {
              role: 'assistant',
              content:
                call.campaign?.botGreeting ||
                'Hello, this is a quick ReachConvert call.',
              timestamp: endedAt.toISOString(),
            },
            {
              role: 'user',
              content: 'Mock call completed.',
              timestamp: endedAt.toISOString(),
            },
          ],
        },
      });
    }
    return {
      status: 'COMPLETED',
      twilio: { placed: calls.length, failed: 0, errors: [] },
    };
  }

  private async addCallableContacts(
    campaignId: string,
    contactIds: string[],
    campaign: Record<string, any>,
  ) {
    const existing = await this.db.callHistory.findMany({
      where: { campaignId },
      select: { contactId: true },
    });
    const existingIds = new Set(existing.map((call: any) => call.contactId));

    for (const contactId of contactIds) {
      if (existingIds.has(contactId)) continue;
      const contact = await this.db.contact.findUnique({ where: { id: contactId } });
      if (!contact?.phoneNumber) continue;
      await this.db.callHistory.create({
        data: {
          campaignId,
          contactId,
          duration: 0,
          sessionStatus: 'pending',
          callType: 'phone_call',
          selectedLanguage:
            campaign.selectedLanguage || campaign.language || 'en-IN',
          selectedVoice:
            campaign.selectedVoice ||
            campaign.voice ||
            'google:en-IN-Chirp3-HD-Puck',
          outcome: 'PENDING',
          status: 'PENDING',
          timestamp: new Date(),
          scripts: [],
        },
      });
    }
  }

  private normalizeCampaignPayload(dto: Record<string, any>) {
    const data: Record<string, unknown> = {};
    const textKeys = [
      'name',
      'description',
      'objective',
      'prompt',
      'voiceQuality',
      'voice',
      'language',
      'selectedLanguage',
      'selectedVoice',
      'aiCallingBotId',
      'botName',
      'botRole',
      'botGoal',
      'botPersonality',
      'botKnowledge',
      'botRules',
      'botObjectionHandling',
      'botGreeting',
      'status',
      'scheduleType',
      'timezone',
      'realtimeModel',
    ];
    for (const key of textKeys) {
      if (typeof dto[key] === 'string') data[key] = dto[key].trim();
    }

    const language =
      String(data.selectedLanguage || data.language || 'en-IN').trim() || 'en-IN';
    const voice = String(data.selectedVoice || data.voice || '').trim();
    data.language = language;
    data.selectedLanguage = language;
    data.voice = this.normalizeVoice(voice, language);
    data.selectedVoice = data.voice;
    data.voiceQuality = data.voiceQuality || 'hd';
    data.aiSpeaksFirst =
      typeof dto.aiSpeaksFirst === 'boolean' ? dto.aiSpeaksFirst : true;
    data.preventInterruption =
      typeof dto.preventInterruption === 'boolean'
        ? dto.preventInterruption
        : false;
    data.realtimeModel =
      data.realtimeModel ||
      process.env.GEMINI_LIVE_MODEL ||
      'gemini-2.5-flash-native-audio-preview-12-2025';
    data.maxTokens = this.numberOr(dto.maxTokens, 4000);
    data.threshold = this.numberOr(dto.threshold, 0);
    data.responseSpeed = normalizeResponseSpeed(dto.responseSpeed);
    data.tools = Array.isArray(dto.tools)
      ? dto.tools
      : ['end_call', 'fetch_context'];
    if (Array.isArray(dto.tags)) data.tags = dto.tags;
    if (dto.concurrencyLimit !== undefined) {
      data.concurrencyLimit = this.numberOr(dto.concurrencyLimit, 50);
    }
    if (dto.scheduledAt) data.scheduledAt = new Date(dto.scheduledAt);
    if (dto.estimatedCost !== undefined) {
      data.estimatedCost = this.numberOr(dto.estimatedCost, 0);
    }
    if (dto.estimatedDuration !== undefined) {
      data.estimatedDuration = this.numberOr(dto.estimatedDuration, 0);
    }
    return data;
  }

  private normalizeVoice(rawVoice: string, language: string) {
    const trimmed = rawVoice || 'google:en-IN-Chirp3-HD-Puck';
    if (trimmed.startsWith('google:')) return trimmed;
    if (/^[a-z]{2,3}-[A-Z]{2}-Chirp3-HD-[A-Za-z]+$/.test(trimmed)) {
      return `google:${trimmed}`;
    }
    return `google:${language}-Chirp3-HD-${trimmed || 'Puck'}`;
  }

  private async withCounts(campaign: any) {
    const calls = Array.isArray(campaign.calls)
      ? campaign.calls
      : await this.db.callHistory.findMany({ where: { campaignId: campaign.id } });
    return {
      ...campaign,
      calls,
      contactCount: calls.length,
      completedCount: calls.filter((call: any) => call.status === 'COMPLETED').length,
      answeredCount: calls.filter((call: any) => call.outcome === 'ANSWERED').length,
      pendingCount: calls.filter((call: any) =>
        ACTIVE_OUTCOMES.has(String(call.outcome || '').toUpperCase()),
      ).length,
      failedCount: calls.filter((call: any) => call.outcome === 'FAILED').length,
    };
  }

  private buildGeneratedCampaign(dto: GenerateCallingCampaignDto) {
    const prompt = dto.prompt?.trim();
    if (!prompt) throw new BadRequestException('Prompt is required.');
    const titleSeed = prompt
      .replace(/[^\w\s-]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
      .join(' ');
    const name = titleSeed
      ? `${titleSeed.charAt(0).toUpperCase()}${titleSeed.slice(1)} Call`
      : 'AI Calling Campaign';
    const tone = dto.tone?.trim() || 'Warm, natural, concise, and helpful';
    return {
      name,
      objective: `Use a ${tone.toLowerCase()} voice call to ${prompt}`,
      prompt: [
        `Campaign objective: ${prompt}`,
        `Tone: ${tone}.`,
        'Open with a brief greeting, confirm the contact has a moment, ask one question at a time, and capture a clear next step.',
        'If the contact is busy, ask for a better callback time. If they object, acknowledge briefly and continue only with permission.',
      ].join('\n'),
      language: 'en-IN',
      voice: 'google:en-IN-Chirp3-HD-Puck',
    };
  }

  private async createTwilioCall(settings: any, callId: string, to: string) {
    const accountSid = settings.twilioAccountSid;
    const authToken = settings.twilioAuthToken;
    const params = new URLSearchParams({
      To: to,
      From: settings.twilioPhoneNumber,
      Url: `${this.getPublicApiBaseUrl()}/calling-campaigns/twilio/answer/${encodeURIComponent(
        callId,
      )}`,
      Method: 'POST',
      StatusCallback: `${this.getPublicApiBaseUrl()}/calling-campaigns/twilio/status/${encodeURIComponent(
        callId,
      )}`,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed',
      RecordingStatusCallback: `${this.getPublicApiBaseUrl()}/calling-campaigns/twilio/recording/${encodeURIComponent(
        callId,
      )}`,
      RecordingStatusCallbackMethod: 'POST',
    });
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        accountSid,
      )}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${accountSid}:${authToken}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.message || response.statusText || 'Twilio error');
    }
    return data;
  }

  private async cancelTwilioCall(settings: any, sid: string) {
    const params = new URLSearchParams({ Status: 'completed' });
    await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        settings.twilioAccountSid,
      )}/Calls/${encodeURIComponent(sid)}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${settings.twilioAccountSid}:${settings.twilioAuthToken}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
        signal: AbortSignal.timeout(10000),
      },
    );
  }

  private async checkAndCompleteCampaign(campaignId: string) {
    const calls = await this.db.callHistory.findMany({ where: { campaignId } });
    if (calls.length === 0) return;
    const hasActive = calls.some((call: any) =>
      ACTIVE_OUTCOMES.has(String(call.outcome || '').toUpperCase()),
    );
    if (!hasActive) {
      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
    }
  }

  private getPublicApiBaseUrl() {
    const raw =
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('API_BASE_URL') ||
      `http://localhost:${this.configService.get<number>('PORT', 3001)}/api`;
    const base = raw.replace(/\/+$/, '');
    return base.endsWith('/api') ? base : `${base}/api`;
  }

  private getPublicWsBaseUrl() {
    const explicit = this.configService.get<string>('PUBLIC_WS_URL');
    if (explicit) return explicit.replace(/\/+$/, '');
    const apiBase = this.getPublicApiBaseUrl();
    const parsed = new URL(apiBase);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    parsed.pathname = parsed.pathname.replace(/\/api\/?$/, '');
    return parsed.toString().replace(/\/+$/, '');
  }

  private hasTwilioSettings(settings: any) {
    return Boolean(
      settings?.twilioAccountSid &&
        settings?.twilioAuthToken &&
        settings?.twilioPhoneNumber,
    );
  }

  private isMockTwilio(settings: any) {
    const haystack = [
      settings?.twilioAccountSid,
      settings?.twilioAuthToken,
      settings?.twilioPhoneNumber,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes('mock') || haystack.includes('test');
  }

  private twilioStatusToOutcome(status: string, duration: number) {
    if (status === 'queued') return 'QUEUED';
    if (status === 'initiated') return 'DIALING';
    if (status === 'ringing') return 'RINGING';
    if (status === 'in-progress') return 'IN_PROGRESS';
    if (status === 'busy') return 'BUSY';
    if (status === 'no-answer') return 'NO_ANSWER';
    if (status === 'canceled' || status === 'cancelled') return 'CANCELLED';
    if (status === 'failed') return 'FAILED';
    if (status === 'completed') return duration > 0 ? 'ANSWERED' : 'NO_ANSWER';
    return status ? status.toUpperCase().replace(/-/g, '_') : 'PENDING';
  }

  private twimlResponse(innerXml: string) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${innerXml}</Response>`;
  }

  private xml(value: string) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private numberOr(value: unknown, fallback: number) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }
}
