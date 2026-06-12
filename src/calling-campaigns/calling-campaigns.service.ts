import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateCallingCampaignDto } from './dto/create-calling-campaign.dto';

@Injectable()
export class CallingCampaignsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const campaigns = await this.prisma.callingCampaign.findMany({
      include: {
        calls: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return campaigns.map(c => ({
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
      answeredCount: c.calls.filter(call => call.outcome === 'ANSWERED').length,
    }));
  }

  async findOne(id: string) {
    const campaign = await this.prisma.callingCampaign.findUnique({
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
    const campaign = await this.prisma.callingCampaign.create({
      data: rest,
    });

    if (contactIds && contactIds.length > 0) {
      // Create initial pending CallHistory items
      for (const contactId of contactIds) {
        const contact = await this.prisma.contact.findUnique({ where: { id: contactId } });
        if (!contact) continue;

        await this.prisma.callHistory.create({
          data: {
            campaignId: campaign.id,
            contactId,
            outcome: 'PENDING',
            duration: 0,
          },
        });
      }
    }

    return campaign;
  }

  async update(id: string, dto: Partial<CreateCallingCampaignDto> & { status?: string }) {
    const { contactIds, ...rest } = dto;
    const campaign = await this.prisma.callingCampaign.update({
      where: { id },
      data: rest,
    });

    if (contactIds) {
      // Delete existing calls that are pending
      await this.prisma.callHistory.deleteMany({
        where: { campaignId: id, outcome: 'PENDING' },
      });

      for (const contactId of contactIds) {
        const contact = await this.prisma.contact.findUnique({ where: { id: contactId } });
        if (!contact) continue;

        const existing = await this.prisma.callHistory.findFirst({
          where: { campaignId: id, contactId },
        });

        if (!existing) {
          await this.prisma.callHistory.create({
            data: {
              campaignId: id,
              contactId,
              outcome: 'PENDING',
              duration: 0,
            },
          });
        }
      }
    }

    return campaign;
  }

  async remove(id: string) {
    return this.prisma.callingCampaign.delete({
      where: { id },
    });
  }

  async launchCampaign(id: string) {
    const campaign = await this.prisma.callingCampaign.findUnique({
      where: { id },
      include: {
        calls: {
          where: { outcome: 'PENDING' },
          include: { contact: true },
        },
      },
    });

    if (!campaign) {
      throw new BadRequestException('Calling campaign not found');
    }

    if (campaign.calls.length === 0) {
      throw new BadRequestException('No pending calls in this campaign');
    }

    await this.prisma.callingCampaign.update({
      where: { id },
      data: { status: 'RUNNING' },
    });

    // Run calling simulation in background
    this.runCallSimulation(campaign.id);

    return { success: true, message: 'Calling campaign started dialer simulation' };
  }

  private async runCallSimulation(campaignId: string) {
    try {
      const campaign = await this.prisma.callingCampaign.findUnique({
        where: { id: campaignId },
        include: {
          calls: {
            where: { outcome: 'PENDING' },
            include: { contact: true },
          },
        },
      });

      if (!campaign) return;

      const outcomes = ['ANSWERED', 'ANSWERED', 'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILED'];
      const recordingUrls = [
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
        'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3',
      ];

      for (const call of campaign.calls) {
        const contact = call.contact;
        // Wait 2 seconds between calls to simulate dialing
        await new Promise(resolve => setTimeout(resolve, 2000));

        const outcome = outcomes[Math.floor(Math.random() * outcomes.length)];
        const duration = outcome === 'ANSWERED' ? Math.floor(Math.random() * 120) + 30 : 0;
        const recordingUrl = outcome === 'ANSWERED' ? recordingUrls[Math.floor(Math.random() * recordingUrls.length)] : null;

        let transcript = null;
        if (outcome === 'ANSWERED') {
          transcript = `Sarah: Hello, am I speaking with ${contact.firstName}?
${contact.firstName}: Yes, this is ${contact.firstName} speaking. Who is this?
Sarah: Hi ${contact.firstName}, my name is Sarah calling from ReachConvert. I saw your application for the Software Engineer role and wanted to schedule a quick conversation.
${contact.firstName}: Oh, awesome! Yes, I am definitely interested.
Sarah: Great! I see you have experience with NestJS and Next.js. Could you tell me a bit about your last project?
${contact.firstName}: Sure, in my last role at ${contact.company || 'my previous company'}, I built a SaaS platform using Next.js on the frontend and NestJS on the backend, complete with Prisma ORM...
Sarah: That sounds exactly like what we are looking for. I will pass your details to the hiring manager and we will follow up with an email to schedule a technical round.
${contact.firstName}: Sounds perfect, thank you Sarah!
Sarah: Thank you, have a great day!`;
        }

        await this.prisma.callHistory.update({
          where: { id: call.id },
          data: {
            outcome,
            duration,
            recordingUrl,
            transcript,
            timestamp: new Date(),
          },
        });
      }

      await this.prisma.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
    } catch (err) {
      console.error('Calling simulation error:', err);
      await this.prisma.callingCampaign.update({
        where: { id: campaignId },
        data: { status: 'FAILED' },
      });
    }
  }

  async getDashboardMetrics() {
    const campaigns = await this.prisma.callingCampaign.findMany();
    const calls = await this.prisma.callHistory.findMany();

    const totalCampaigns = campaigns.length;
    const activeCampaigns = campaigns.filter(c => c.status === 'RUNNING').length;
    const scheduledCalls = calls.filter(c => c.outcome === 'PENDING').length;
    const completedCalls = calls.filter(c => c.outcome !== 'PENDING').length;

    return {
      totalCampaigns,
      activeCampaigns,
      scheduledCalls,
      completedCalls,
    };
  }
}
