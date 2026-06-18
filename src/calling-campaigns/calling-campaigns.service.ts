import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';

type TwilioSettings = {
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioPhoneNumber?: string;
  twilioStatus?: string;
};

@Injectable()
export class CallingCampaignsService {
  private readonly logger = new Logger(CallingCampaignsService.name);

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

        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            provider: 'TWILIO',
            status: 'QUEUING',
            outcome: 'QUEUING',
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

        // 1. DIALING
        await this.db.callHistory.update({
          where: { id: call.id },
          data: {
            provider: 'SIMULATION',
            status: 'DIALING',
            outcome: 'DIALING',
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 2. RINGING
        await this.db.callHistory.update({
          where: { id: call.id },
          data: { status: 'RINGING', outcome: 'RINGING' },
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];

        if (outcome === 'ANSWERED') {
          // 3. CONNECTED / IN PROGRESS
          await this.db.callHistory.update({
            where: { id: call.id },
            data: { status: 'CONNECTED', outcome: 'CONNECTED' },
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
          const summary = `Evaluated candidate ${contact.firstName} for software engineering. Strong skills in Next.js and NestJS, eager to join.`;
          const keyOutcomes =
            'Scheduled candidate for next round; sent confirmation email.';

          const transcript = `AI Agent: Hello, am I speaking with ${contact.firstName}?
Customer: Yes, this is ${contact.firstName} speaking. Who is this?
AI Agent: Hi ${contact.firstName}, my name is Sarah calling from ReachConvert. I saw your application for the Software Engineer role and wanted to schedule a quick conversation.
Customer: Oh, awesome! Yes, I am definitely interested.
AI Agent: Great! I see you have experience with NestJS and Next.js. Could you tell me a bit about your last project?
Customer: Sure, in my last role at ${contact.company || 'my previous company'}, I built a SaaS platform using Next.js on the frontend and NestJS on the backend, complete with MongoDB...
AI Agent: That sounds exactly like what we are looking for. I will pass your details to the hiring manager and we will follow up with an email to schedule a technical round.
Customer: Sounds perfect, thank you Sarah!
AI Agent: Thank you, have a great day!`;

          await this.db.callHistory.update({
            where: { id: call.id },
            data: {
              outcome: 'ANSWERED',
              status: 'COMPLETED',
              duration,
              recordingUrl,
              transcript,
              summary,
              sentimentScore,
              keyOutcomes,
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
              status:
                outcome === 'NO_ANSWER'
                  ? 'NO_ANSWER'
                  : outcome === 'BUSY'
                    ? 'BUSY'
                    : 'FAILED',
              duration: 0,
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
          duration: 0,
        },
      });
      added++;
    }

    return { added, skipped };
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
          summary: null,
          sentimentScore: 5.0,
          keyOutcomes: null,
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
    const firstName = contact.firstName || 'there';
    const objective =
      campaign.objective ||
      'follow up with you and understand whether this is a good time to talk';
    const prompt = campaign.prompt
      ? ` The campaign instructions are: ${campaign.prompt}`
      : '';
    const message = `Hello ${firstName}. This is ReachConvert calling about ${objective}.${prompt} This first live calling version can place the outbound call and read this opening message. Please follow up from the ReachConvert dashboard for the full call result.`;

    const language = campaign.language === 'en-IN' ? 'en-IN' : 'en-US';

    return `<Response><Say voice="alice" language="${language}">${this.escapeXml(message)}</Say><Pause length="1"/><Say voice="alice" language="${language}">Thank you. Goodbye.</Say></Response>`;
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
