import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService } from '../mongo.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';
import { GenerateCallingCampaignDto } from './dto/generate-calling-campaign.dto';
import { resolveOpenRouterModel } from '../config/openrouter';

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
  botPersonality: string;
  botKnowledge: string;
  botRules: string;
  botObjectionHandling: string;
  botGreeting: string;
  voice: string;
  language: string;
};

type CallingCampaignGenerationJob = {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: GeneratedCallingCampaign;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class CallingCampaignsService {
  private readonly logger = new Logger(CallingCampaignsService.name);
  private generationJobs = new Map<string, CallingCampaignGenerationJob>();

  constructor(private db: MongoService) {}

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
      voice: c.voice,
      language: c.language,
      botName: c.botName,
      botRole: c.botRole,
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
    const campaign = await this.db.callingCampaign.create({
      data: rest,
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

    const settings = await this.db.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const tone = dto.tone?.trim() || 'warm, natural, concise, and helpful';

    if (
      !settings?.openRouterApiKey ||
      settings.openRouterApiKey.toLowerCase().includes('mock') ||
      settings.openRouterApiKey.toLowerCase().includes('test')
    ) {
      return this.buildMockGeneratedCampaign(userPrompt, tone);
    }

    const prompt = `You are an expert AI calling campaign designer. Create a complete outbound AI calling campaign from this user request:

USER REQUEST:
${userPrompt}

TONE:
${tone}

The calling agent must act like a real person, not like a prompt reader. It should ask permission, listen first, handle objections briefly, and capture a clear next step.

Return ONLY valid JSON with exactly these fields:
{
  "name": "Short campaign name",
  "objective": "One sentence goal",
  "prompt": "Campaign context and call instructions",
  "botName": "Human first name",
  "botRole": "Human role for the caller",
  "botPersonality": "Natural persona instructions",
  "botKnowledge": "Facts, offer details, qualification points, and context the bot should know",
  "botRules": "Rules the bot must follow",
  "botObjectionHandling": "How to respond to common objections",
  "botGreeting": "Opening line using {{firstName}} and {{botName}} variables",
  "voice": "One Gemini voice from: Kore, Puck, Zephyr, Charon, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat",
  "language": "BCP-47 language code such as en-IN or en"
}`;

    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.openRouterApiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://reachconvert.com',
          'X-Title': 'ReachConvert',
        },
        body: JSON.stringify({
          model: resolveOpenRouterModel(settings.openRouterModel),
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
      },
    );

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BadRequestException(
        data?.error?.metadata?.raw ||
          data?.error?.message ||
          'AI campaign generation failed.',
      );
    }

    const contentString = data?.choices?.[0]?.message?.content;
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
    const campaign = await this.db.callingCampaign.update({
      where: { id },
      data: rest,
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

  async launchCampaign(id: string) {
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

    if (campaign.status === 'RUNNING') {
      this.logger.warn(`Launch blocked for campaign ${id}: already running`);
      throw new BadRequestException('Calling campaign is already running');
    }

    const settings = await this.db.systemSettings.findUnique({
      where: { id: 'default' },
    });
    const hasTwilio = this.hasUsableTwilioSettings(settings);
    const launchMode = hasTwilio ? 'twilio' : 'simulation';
    this.logger.debug(
      `Campaign ${id} launch provider check: Twilio status=${settings?.twilioStatus || 'DISCONNECTED'}, from=${settings?.twilioPhoneNumber || 'not configured'}; current mode=${launchMode}`,
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

    if (pendingCallableCalls.length === 0) {
      this.logger.debug(
        `Relaunch requested for campaign ${id}; resetting ${callableCalls.length} previous calls to PENDING`,
      );
      await this.resetCallsForRelaunch(callableCalls);
    }

    await this.db.callingCampaign.update({
      where: { id },
      data: { status: 'RUNNING' },
    });

    if (hasTwilio) {
      this.runTwilioOutboundCalls(campaign.id, settings);
    } else {
      this.logger.warn(
        `Campaign ${id} is using simulation because Twilio is not fully connected`,
      );
      this.runCallSimulation(campaign.id);
    }

    return {
      success: true,
      message:
        pendingCallableCalls.length === 0
          ? `Calling campaign relaunched in ${launchMode} mode`
          : `Calling campaign started in ${launchMode} mode`,
    };
  }

  private async runTwilioOutboundCalls(
    campaignId: string,
    settings: TwilioSettings,
  ) {
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
        return;
      }

      let placed = 0;
      let failed = 0;

      for (const call of campaign.calls) {
        const contact = call.contact;
        if (!this.hasCallablePhone(contact)) {
          failed++;
          this.logger.warn(
            `Skipping Twilio call ${call.id} in campaign ${campaignId}: contact ${call.contactId} has no phone number`,
          );
          continue;
        }

        this.logger.debug(
          `Creating Twilio call ${call.id} from ${settings.twilioPhoneNumber} to ${this.maskPhoneNumber(contact.phoneNumber)}`,
        );
        const botProfile = this.buildBotProfile(campaign);
        const openingScript = this.buildOpeningScript(
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
            selectedLanguage: campaign.language || 'en-IN',
            selectedVoice: campaign.voice || 'Kore',
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

        const result = await this.createTwilioCall({
          accountSid: settings.twilioAccountSid || '',
          authToken: settings.twilioAuthToken || '',
          from: settings.twilioPhoneNumber || '',
          to: contact.phoneNumber,
          twiml: this.buildCallTwiml(campaign, contact),
        });

        if (result.ok) {
          placed++;
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
          failed++;
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
          this.logger.error(`Twilio rejected call ${call.id}: ${result.error}`);
        }
      }

      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: failed > 0 && placed === 0 ? 'FAILED' : 'COMPLETED' },
      });
      this.logger.debug(
        `Twilio campaign ${campaignId} finished queueing: ${placed} accepted, ${failed} failed`,
      );
    } catch (err) {
      this.logger.error(
        `Twilio calling error for campaign ${campaignId}`,
        err instanceof Error ? err.stack : String(err),
      );
      await this.db.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'FAILED' },
      });
    }
  }

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

        // 1. DIALING
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            provider: 'SIMULATION',
            status: 'DIALING',
            outcome: 'DIALING',
            sessionStatus: 'inprogress',
            callType: 'phone_call',
            selectedLanguage: campaign.language || 'en-IN',
            selectedVoice: campaign.voice || 'Kore',
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
          const sentimentScore = parseFloat((Math.random() * 3 + 7).toFixed(1)); // positive 7.0 - 10.0
          const botProfile = this.buildBotProfile(campaign);
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
          // Failure or no answer
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

  private async addCallableContacts(campaignId: string, contactIds: string[]) {
    let added = 0;
    let skipped = 0;

    for (const contactId of contactIds) {
      const contact = await this.db.contact.findUnique({
        where: { id: contactId },
      });

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

      const existing = await this.db.callHistory.findFirst({
        where: { campaignId, contactId },
      });

      if (existing) {
        skipped++;
        this.logger.debug(
          `Skipping contact ${contactId} for campaign ${campaignId}: call already exists`,
        );
        continue;
      }

      await this.db.callHistory.create({
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
      });
      added++;
    }

    return { added, skipped };
  }

  private buildMockGeneratedCampaign(userPrompt: string, tone: string) {
    return this.normalizeGeneratedCampaign(
      {
        name: 'AI Calling Campaign',
        objective:
          'Call selected contacts, qualify interest, and capture the next best follow-up.',
        prompt: userPrompt,
        botName: 'Alex',
        botRole: 'calling specialist',
        botPersonality: tone,
        botKnowledge: userPrompt,
        botRules:
          'Ask permission before continuing. Keep the call brief. Do not overpromise. Confirm the next step before ending.',
        botObjectionHandling:
          'If they are busy, ask for a better callback time. If they are unsure, offer to send details. If they are not interested, thank them politely and close.',
        botGreeting:
          'Hi {{firstName}}, this is {{botName}}. I know this is a quick call, so I will be brief.',
        voice: 'Kore',
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
    const allowedVoices = new Set([
      'Kore',
      'Puck',
      'Zephyr',
      'Charon',
      'Fenrir',
      'Leda',
      'Orus',
      'Aoede',
      'Callirrhoe',
      'Autonoe',
      'Enceladus',
      'Iapetus',
      'Umbriel',
      'Algieba',
      'Despina',
      'Erinome',
      'Algenib',
      'Rasalgethi',
      'Laomedeia',
      'Achernar',
      'Alnilam',
      'Schedar',
      'Gacrux',
      'Pulcherrima',
      'Achird',
      'Zubenelgenubi',
      'Vindemiatrix',
      'Sadachbia',
      'Sadaltager',
      'Sulafat',
    ]);

    const pick = (key: string, fallback: string) => {
      const text = typeof value?.[key] === 'string' ? value[key].trim() : '';
      return text || fallback;
    };
    const voice = pick('voice', 'Kore');
    const language = pick('language', 'en-IN');

    return {
      name: pick('name', 'AI Calling Campaign').slice(0, 90),
      objective: pick(
        'objective',
        'Call contacts, qualify interest, and capture the next step.',
      ),
      prompt: pick('prompt', userPrompt),
      botName: pick('botName', 'Alex'),
      botRole: pick('botRole', 'calling specialist'),
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
      voice: allowedVoices.has(voice) ? voice : 'Kore',
      language: /^[a-z]{2,3}(-[A-Z]{2})?$/.test(language) ? language : 'en-IN',
    };
  }

  private parseJsonObject(content: string) {
    let cleanedJson = content.trim();
    if (cleanedJson.startsWith('```')) {
      cleanedJson = cleanedJson
        .replace(/^```json/, '')
        .replace(/^```/, '')
        .replace(/```$/, '')
        .trim();
    }

    return JSON.parse(cleanedJson);
  }

  private async resetCallsForRelaunch(calls: any[]) {
    for (const call of calls) {
      await this.db.callHistory.update({
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
      });
    }
  }

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
    twiml,
  }: {
    accountSid: string;
    authToken: string;
    from: string;
    to: string;
    twiml: string;
  }): Promise<
    { ok: true; sid: string; status: string } | { ok: false; error: string }
  > {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const body = new URLSearchParams({
      To: to,
      From: from,
      Twiml: twiml,
    });

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

  private buildCallTwiml(campaign: any, contact: any) {
    const botProfile = this.buildBotProfile(campaign);
    const message = this.buildOpeningScript(campaign, contact, botProfile);
    const language = campaign.language === 'en-IN' ? 'en-IN' : 'en-US';
    const twilioVoice = this.resolveTwilioVoice(campaign.voice, language);

    return `<Response><Say voice="${twilioVoice}" language="${language}">${this.escapeXml(message)}</Say><Pause length="1"/><Say voice="${twilioVoice}" language="${language}">Thanks for your time. I will let the team know and they will follow up with the next step.</Say></Response>`;
  }

  private buildBotProfile(campaign: any) {
    return {
      name: campaign.botName?.trim() || 'Alex',
      role: campaign.botRole?.trim() || 'calling specialist',
      personality:
        campaign.botPersonality?.trim() ||
        'warm, concise, calm, and naturally conversational',
      knowledge: campaign.botKnowledge?.trim() || campaign.prompt?.trim() || '',
      rules:
        campaign.botRules?.trim() ||
        'ask permission before continuing, listen first, keep the call brief, and never overpromise',
      objections:
        campaign.botObjectionHandling?.trim() ||
        'if the contact is busy, ask for a better callback time; if they are unsure, offer to send details',
      greeting: campaign.botGreeting?.trim() || '',
    };
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

    return [
      greeting,
      `I am a ${botProfile.role}, calling about ${objective}.`,
      `I will keep this ${this.sentenceFromText(botProfile.personality).toLowerCase()}`,
      `I wanted to see if this is relevant for ${company} and ask one or two quick questions before suggesting a next step.`,
      context,
      `If now is not a good time, no problem. I can note a better callback time or send the details instead.`,
      rules ? `I will keep this simple: ${rules}` : '',
    ]
      .filter(Boolean)
      .join(' ');
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
      objective: campaign.objective || '',
    };

    return value.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || '');
  }

  private sentenceFromText(value?: string) {
    const text = value?.replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const shortened = text.length > 260 ? `${text.slice(0, 257)}...` : text;
    return /[.!?]$/.test(shortened) ? shortened : `${shortened}.`;
  }

  private resolveTwilioVoice(voice?: string, language?: string) {
    if (language === 'en-IN') return 'Polly.Aditi';

    const supportedVoices: Record<string, string> = {
      Kore: 'Polly.Matthew',
      Puck: 'Polly.Justin',
      Zephyr: 'Polly.Joanna',
      Charon: 'Polly.Brian',
      Iapetus: 'Polly.Matthew',
      Achernar: 'Polly.Amy',
      Achird: 'Polly.Joey',
      Sulafat: 'Polly.Joanna',
    };

    return supportedVoices[voice || ''] || 'Polly.Joanna';
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
}
