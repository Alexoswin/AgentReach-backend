import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { AddContactsDto } from './dto/add-contacts.dto';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

@Injectable()
export class EmailCampaignsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    const campaigns = await this.prisma.emailCampaign.findMany({
      include: {
        template: { select: { id: true, name: true } },
        contacts: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return campaigns.map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      template: c.template,
      contactCount: c.contacts.length,
    }));
  }

  async findOne(id: string) {
    const campaign = await this.prisma.emailCampaign.findUnique({
      where: { id },
      include: {
        template: true,
        contacts: {
          include: {
            contact: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    return campaign;
  }

  async create(dto: CreateCampaignDto) {
    return this.prisma.emailCampaign.create({
      data: dto,
    });
  }

  async update(id: string, dto: Partial<CreateCampaignDto> & { status?: string }) {
    return this.prisma.emailCampaign.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string) {
    return this.prisma.emailCampaign.delete({
      where: { id },
    });
  }

  async addContacts(campaignId: string, dto: AddContactsDto) {
    const campaign = await this.prisma.emailCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    let addedCount = 0;
    for (const contactId of dto.contactIds) {
      // Check if contact exists
      const contact = await this.prisma.contact.findUnique({ where: { id: contactId } });
      if (!contact) continue;

      // Check if contact already in campaign
      const existing = await this.prisma.emailCampaignContact.findFirst({
        where: { campaignId, contactId },
      });

      if (!existing) {
        await this.prisma.emailCampaignContact.create({
          data: {
            campaignId,
            contactId,
            deliveryStatus: 'PENDING',
          },
        });
        addedCount++;
      }
    }

    return { success: true, addedCount };
  }

  async removeContact(campaignId: string, contactId: string) {
    const record = await this.prisma.emailCampaignContact.findFirst({
      where: { campaignId, contactId },
    });

    if (!record) {
      throw new BadRequestException('Contact not associated with this campaign');
    }

    return this.prisma.emailCampaignContact.delete({
      where: { id: record.id },
    });
  }

  async launchCampaign(id: string) {
    const campaign = await this.prisma.emailCampaign.findUnique({
      where: { id },
      include: {
        template: true,
        contacts: {
          where: { deliveryStatus: 'PENDING' },
          include: { contact: true },
        },
      },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    if (!campaign.template) {
      throw new BadRequestException('Cannot launch a campaign without an email template');
    }

    if (campaign.contacts.length === 0) {
      throw new BadRequestException('No pending contacts in this campaign');
    }

    // Set campaign status to RUNNING
    await this.prisma.emailCampaign.update({
      where: { id },
      data: { status: 'RUNNING' },
    });

    // Execute sending in the background
    this.runBackgroundSending(campaign.id);

    return { success: true, message: 'Campaign execution started in background' };
  }

  private async runBackgroundSending(campaignId: string) {
    try {
      const settings = await this.prisma.systemSettings.findUnique({
        where: { id: 'default' },
      });

      const campaign = await this.prisma.emailCampaign.findUnique({
        where: { id: campaignId },
        include: {
          template: true,
          contacts: {
            where: { deliveryStatus: 'PENDING' },
            include: { contact: true },
          },
        },
      });

      if (!campaign || !campaign.template) return;

      const template = campaign.template;
      const isMockSes = !settings || 
        !settings.awsAccessKeyId || 
        settings.awsAccessKeyId.toLowerCase().includes('mock') || 
        settings.awsAccessKeyId.toLowerCase().includes('test');

      let client: SESClient | null = null;
      if (!isMockSes && settings) {
        client = new SESClient({
          region: settings.awsRegion || 'us-east-1',
          credentials: {
            accessKeyId: settings.awsAccessKeyId,
            secretAccessKey: settings.awsSecretAccessKey,
          },
        });
      }

      for (const campaignContact of campaign.contacts) {
        const contact = campaignContact.contact;
        const subject = this.interpolate(template.subject, contact);
        const bodyHtml = this.interpolate(template.bodyHtml, contact);
        const bodyText = this.interpolate(template.bodyText, contact);

        try {
          if (isMockSes || !client || !settings) {
            // Simulated delay and random response for Mock mode
            await new Promise(r => setTimeout(r, 1000));
            // Simulate 90% success, 10% failure
            const isSuccess = Math.random() > 0.1;
            if (isSuccess) {
              await this.prisma.emailCampaignContact.update({
                where: { id: campaignContact.id },
                data: {
                  deliveryStatus: 'SENT',
                  sentTime: new Date(),
                  subject,
                  bodyHtml,
                  bodyText,
                },
              });
            } else {
              throw new Error('Simulated AWS SES delivery throttling error');
            }
          } else {
            const command = new SendEmailCommand({
              Source: settings.awsSenderEmail,
              Destination: {
                ToAddresses: [contact.email],
              },
              Message: {
                Subject: { Data: subject },
                Body: {
                  Html: { Data: bodyHtml },
                  Text: { Data: bodyText },
                },
              },
            });

            await client.send(command);

            await this.prisma.emailCampaignContact.update({
              where: { id: campaignContact.id },
              data: {
                deliveryStatus: 'SENT',
                sentTime: new Date(),
                subject,
                bodyHtml,
                bodyText,
              },
            });
          }
        } catch (err: any) {
          await this.prisma.emailCampaignContact.update({
            where: { id: campaignContact.id },
            data: {
              deliveryStatus: 'FAILED',
              sentTime: new Date(),
              subject,
              bodyHtml,
              bodyText,
              errorMessage: err.message || 'Unknown SES sending error',
            },
          });
        }
      }

      // Update campaign status to COMPLETED
      await this.prisma.emailCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
    } catch (error) {
      console.error('Error executing campaign background sending:', error);
      await this.prisma.emailCampaign.update({
        where: { id: campaignId },
        data: { status: 'FAILED' },
      });
    }
  }

  private interpolate(templateString: string, contact: any): string {
    if (!templateString) return '';
    let result = templateString;

    result = result.replace(/\{\{firstName\}\}/g, contact.firstName || '');
    result = result.replace(/\{\{lastName\}\}/g, contact.lastName || '');
    result = result.replace(/\{\{company\}\}/g, contact.company || '');
    result = result.replace(/\{\{jobTitle\}\}/g, contact.jobTitle || '');
    result = result.replace(/\{\{email\}\}/g, contact.email || '');

    if (contact.customFields) {
      try {
        const customs = JSON.parse(contact.customFields);
        for (const [key, value] of Object.entries(customs)) {
          const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
          result = result.replace(regex, (value as string) || '');
        }
      } catch (e) {
        // Ignore JSON errors
      }
    }

    // Replace any leftover placeholders
    result = result.replace(/\{\{.*?\}\}/g, '');
    return result;
  }
}
