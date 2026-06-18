import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';

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
          where: { outcome: 'PENDING' },
          include: { contact: true },
        },
      },
    });

    if (!campaign) {
      this.logger.warn(`Launch failed: calling campaign ${id} not found`);
      throw new BadRequestException('Calling campaign not found');
    }

    const callableCalls = campaign.calls.filter((call: any) =>
      this.hasCallablePhone(call.contact),
    );
    const skippedCalls = campaign.calls.length - callableCalls.length;

    this.logger.debug(
      `Campaign ${id} launch check: ${campaign.calls.length} pending calls, ${callableCalls.length} with phone numbers, ${skippedCalls} skipped`,
    );

    if (callableCalls.length === 0) {
      this.logger.warn(
        `Launch blocked for campaign ${id}: no pending calls with phone numbers`,
      );
      throw new BadRequestException('No pending calls in this campaign');
    }

    await this.db.callingCampaign.update({
      where: { id },
      data: { status: 'RUNNING' },
    });

    // Run calling simulation in background
    this.runCallSimulation(campaign.id);

    return {
      success: true,
      message: 'Calling campaign started dialer simulation',
    };
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
          `Dialing call ${call.id} for ${contact.firstName} ${contact.lastName} at ${contact.phoneNumber}`,
        );

        // 1. DIALING
        await this.db.callHistory.update({
          where: { id: call.id },
          data: { status: 'DIALING', outcome: 'DIALING' },
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
          const recordingUrl = recordingUrls[Math.floor(Math.random() * recordingUrls.length)];
          const sentimentScore = parseFloat((Math.random() * 3 + 7).toFixed(1)); // positive 7.0 - 10.0
          const summary = `Evaluated candidate ${contact.firstName} for software engineering. Strong skills in Next.js and NestJS, eager to join.`;
          const keyOutcomes = 'Scheduled candidate for next round; sent confirmation email.';

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
              status: outcome === 'NO_ANSWER' ? 'NO_ANSWER' : outcome === 'BUSY' ? 'BUSY' : 'FAILED',
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

  private hasCallablePhone(contact: any) {
    return Boolean(contact?.phoneNumber?.trim());
  }
}
