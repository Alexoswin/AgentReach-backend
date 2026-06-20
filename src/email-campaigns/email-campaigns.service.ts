import { Injectable, BadRequestException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { AddContactsDto } from './dto/add-contacts.dto';
import {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
} from '@aws-sdk/client-ses';
import { decryptSystemSettings } from '../settings/credential-encryption';

const SENDER_EMAIL = 'oswin.alex@oswinalex.site';
const SENDER_SOURCE = `"oswin.alex" <${SENDER_EMAIL}>`;

@Injectable()
export class EmailCampaignsService {
  constructor(private db: MongoService) {}

  async findAll() {
    const campaigns = await this.db.emailCampaign.findMany({
      include: {
        template: { select: { id: true, name: true } },
        contacts: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return campaigns.map((c) => ({
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
    const campaign = await this.db.emailCampaign.findUnique({
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
    return this.db.emailCampaign.create({
      data: dto,
    });
  }

  async update(
    id: string,
    dto: Partial<CreateCampaignDto> & { status?: string },
  ) {
    return this.db.emailCampaign.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string) {
    return this.db.emailCampaign.delete({
      where: { id },
    });
  }

  async addContacts(campaignId: string, dto: AddContactsDto) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    let addedCount = 0;
    for (const contactId of dto.contactIds) {
      // Check if contact exists
      const contact = await this.db.contact.findUnique({
        where: { id: contactId },
      });
      if (!contact) continue;

      // Check if contact already in campaign
      const existing = await this.db.emailCampaignContact.findFirst({
        where: { campaignId, contactId },
      });

      if (!existing) {
        await this.db.emailCampaignContact.create({
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
    const record = await this.db.emailCampaignContact.findFirst({
      where: { campaignId, contactId },
    });

    if (!record) {
      throw new BadRequestException(
        'Contact not associated with this campaign',
      );
    }

    return this.db.emailCampaignContact.delete({
      where: { id: record.id },
    });
  }

  async launchCampaign(id: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id },
      include: {
        template: true,
        contacts: true,
      },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    if (!campaign.template) {
      throw new BadRequestException(
        'Cannot launch a campaign without an email template',
      );
    }

    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Campaign is already running');
    }

    if (campaign.contacts.length === 0) {
      throw new BadRequestException('No contacts in this campaign');
    }

    const pendingCount = campaign.contacts.filter(
      (contact: any) => contact.deliveryStatus === 'PENDING',
    ).length;
    const isRelaunch = pendingCount === 0;

    if (isRelaunch) {
      await this.db.emailCampaignContact.updateMany({
        where: { campaignId: id },
        data: {
          deliveryStatus: 'PENDING',
          sentTime: null,
          subject: null,
          bodyHtml: null,
          bodyText: null,
          openStatus: false,
          replyStatus: false,
          errorMessage: null,
        },
      });
    }

    // Set campaign status to RUNNING
    await this.db.emailCampaign.update({
      where: { id },
      data: { status: 'RUNNING' },
    });

    // Execute sending in the background
    this.runBackgroundSending(campaign.id);

    return {
      success: true,
      message: isRelaunch
        ? 'Campaign relaunched. All recipients were queued again.'
        : 'Campaign execution started in background',
    };
  }

  private async runBackgroundSending(campaignId: string) {
    try {
      const settings = decryptSystemSettings(
        await this.db.systemSettings.findUnique({
          where: { id: 'default' },
        }),
      );

      const campaign = await this.db.emailCampaign.findUnique({
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
      const isMockSes =
        !settings ||
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
        if (!contact) {
          await this.db.emailCampaignContact.update({
            where: { id: campaignContact.id },
            data: {
              deliveryStatus: 'FAILED',
              sentTime: new Date(),
              errorMessage: 'Contact no longer exists',
            },
          });
          continue;
        }

        const subject = this.interpolate(template.subject, contact);
        const bodyHtml = this.interpolate(template.bodyHtml, contact);
        const bodyText = this.interpolate(template.bodyText, contact);
        const attachments = this.normalizeTemplateAttachments(
          template.attachments,
          contact,
        );
        const messageBody: {
          Html?: { Data: string };
          Text?: { Data: string };
        } = {};

        if (bodyHtml.trim()) {
          messageBody.Html = { Data: bodyHtml };
        }

        if (bodyText.trim()) {
          messageBody.Text = { Data: bodyText };
        }

        try {
          if (!messageBody.Html && !messageBody.Text) {
            throw new Error('Template has no email body content');
          }

          if (isMockSes || !client || !settings) {
            // Simulated delay and random response for Mock mode
            await new Promise((r) => setTimeout(r, 1000));
            // Simulate 90% success, 10% failure
            const isSuccess = Math.random() > 0.1;
            if (isSuccess) {
              await this.db.emailCampaignContact.update({
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
            if (attachments.length > 0) {
              const command = new SendRawEmailCommand({
                RawMessage: {
                  Data: Buffer.from(
                    this.buildRawEmail({
                      to: contact.email,
                      subject,
                      bodyHtml,
                      bodyText,
                      attachments,
                    }),
                  ),
                },
              });

              await client.send(command);
            } else {
              const command = new SendEmailCommand({
                Source: SENDER_SOURCE,
                Destination: {
                  ToAddresses: [contact.email],
                },
                Message: {
                  Subject: { Data: subject },
                  Body: messageBody,
                },
              });

              await client.send(command);
            }

            await this.db.emailCampaignContact.update({
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
          await this.db.emailCampaignContact.update({
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
      await this.db.emailCampaign.update({
        where: { id: campaignId },
        data: { status: 'COMPLETED' },
      });
    } catch (error) {
      console.error('Error executing campaign background sending:', error);
      await this.db.emailCampaign.update({
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
      } catch {
        // Ignore JSON errors
      }
    }

    // Replace any leftover placeholders
    result = result.replace(/\{\{.*?\}\}/g, '');
    return result;
  }

  private normalizeTemplateAttachments(attachments: any[] = [], contact: any) {
    return attachments
      .filter((attachment) => attachment?.name && attachment?.contentBase64)
      .map((attachment) => ({
        name: this.interpolate(attachment.name, contact),
        contentType: attachment.contentType || 'application/octet-stream',
        contentBase64: attachment.contentBase64,
      }));
  }

  private buildRawEmail({
    to,
    subject,
    bodyHtml,
    bodyText,
    attachments,
  }: {
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
    attachments: { name: string; contentType: string; contentBase64: string }[];
  }) {
    const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const altBoundary = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const lines: string[] = [
      `From: ${SENDER_SOURCE}`,
      `To: ${to}`,
      `Subject: ${this.encodeMimeHeader(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      '',
    ];

    if (bodyText.trim()) {
      lines.push(
        `--${altBoundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        this.chunkBase64(Buffer.from(bodyText, 'utf8').toString('base64')),
        '',
      );
    }

    if (bodyHtml.trim()) {
      lines.push(
        `--${altBoundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        this.chunkBase64(Buffer.from(bodyHtml, 'utf8').toString('base64')),
        '',
      );
    }

    lines.push(`--${altBoundary}--`, '');

    attachments.forEach((attachment) => {
      const fileName = this.escapeMimeParameter(attachment.name);
      lines.push(
        `--${mixedBoundary}`,
        `Content-Type: ${attachment.contentType}; name="${fileName}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${fileName}"`,
        '',
        this.chunkBase64(attachment.contentBase64),
        '',
      );
    });

    lines.push(`--${mixedBoundary}--`, '');
    return lines.join('\r\n');
  }

  private chunkBase64(value: string) {
    return (
      value
        .replace(/\s/g, '')
        .match(/.{1,76}/g)
        ?.join('\r\n') || ''
    );
  }

  private encodeMimeHeader(value: string) {
    return `=?UTF-8?B?${Buffer.from(value || '', 'utf8').toString('base64')}?=`;
  }

  private escapeMimeParameter(value: string) {
    return (value || 'attachment').replace(/[\r\n"]/g, '_').slice(0, 180);
  }
}
