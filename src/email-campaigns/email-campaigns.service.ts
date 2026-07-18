import { Injectable, BadRequestException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { AddContactsDto } from './dto/add-contacts.dto';
import {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
} from '@aws-sdk/client-ses';
import { decryptSystemSettings } from '../settings/credential-encryption';

@Injectable()
export class EmailCampaignsService {
  constructor(private db: MongoService) {}

  async findAll() {
    const campaigns = await this.db.emailCampaign.findMany({
      include: {
        template: { select: { id: true, name: true } },
        contacts: { select: { id: true, deliveryStatus: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      scheduledAt: c.scheduledAt,
      template: c.template,
      contactCount: c.contacts.length,
      pendingCount: c.contacts.filter(
        (contact: any) => contact.deliveryStatus === 'PENDING',
      ).length,
      failedCount: c.contacts.filter(
        (contact: any) => contact.deliveryStatus === 'FAILED',
      ).length,
      sentCount: c.contacts.filter((contact: any) =>
        ['SENT', 'DELIVERED'].includes(contact.deliveryStatus),
      ).length,
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
    if (dto.templateId) {
      await this.assertTemplateExists(dto.templateId);
    }

    return this.db.emailCampaign.create({
      data: dto,
    });
  }

  async update(id: string, dto: UpdateCampaignDto) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (dto.templateId) {
      await this.assertTemplateExists(dto.templateId);
    }

    return this.db.emailCampaign.update({
      where: { id },
      data: dto,
    });
  }

  private async assertTemplateExists(templateId: string) {
    const template = await this.db.template.findUnique({
      where: { id: templateId },
    });
    if (!template) {
      throw new BadRequestException('Template not found');
    }
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

    const uniqueContactIds = Array.from(new Set(dto.contactIds));
    if (uniqueContactIds.length === 0) {
      return { success: true, addedCount: 0 };
    }

    const [existingContacts, existingLinks] = await Promise.all([
      this.db.contact.findMany({
        where: { id: { in: uniqueContactIds } },
      }),
      this.db.emailCampaignContact.findMany({
        where: { campaignId, contactId: { in: uniqueContactIds } },
      }),
    ]);

    const validContactIds = new Set(
      existingContacts.map((contact: any) => contact.id),
    );
    const alreadyLinkedContactIds = new Set(
      existingLinks.map((link: any) => link.contactId),
    );

    const contactIdsToAdd = uniqueContactIds.filter(
      (contactId) =>
        validContactIds.has(contactId) &&
        !alreadyLinkedContactIds.has(contactId),
    );

    await Promise.all(
      contactIdsToAdd.map((contactId) =>
        this.db.emailCampaignContact.create({
          data: {
            campaignId,
            contactId,
            deliveryStatus: 'PENDING',
          },
        }),
      ),
    );

    return { success: true, addedCount: contactIdsToAdd.length };
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

  async scheduleCampaign(id: string, scheduledAt: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id },
      include: { template: true, contacts: true },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (!campaign.template) {
      throw new BadRequestException(
        'Cannot schedule a campaign without an email template',
      );
    }
    if (!campaign.contacts || campaign.contacts.length === 0) {
      throw new BadRequestException('No contacts in this campaign');
    }
    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Campaign is already running');
    }

    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('Invalid schedule date/time');
    }
    if (when.getTime() <= Date.now()) {
      throw new BadRequestException('Schedule time must be in the future');
    }

    await this.db.emailCampaign.update({
      where: { id },
      data: { status: 'SCHEDULED', scheduledAt: when },
    });

    return {
      success: true,
      scheduledAt: when.toISOString(),
      message: `Campaign scheduled for ${when.toISOString()}`,
    };
  }

  async unscheduleCampaign(id: string) {
    const campaign = await this.db.emailCampaign.findUnique({ where: { id } });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    await this.db.emailCampaign.update({
      where: { id },
      data: { status: 'DRAFT', scheduledAt: null },
    });

    return { success: true, message: 'Schedule cancelled' };
  }

  /** Returns SCHEDULED campaigns whose scheduledAt is due (used by the cron). */
  async findDueScheduled() {
    return this.db.emailCampaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
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

    const neverAttempted = campaign.contacts.filter(
      (contact: any) => contact.deliveryStatus === 'PENDING',
    );
    const failed = campaign.contacts.filter(
      (contact: any) => contact.deliveryStatus === 'FAILED',
    );

    if (neverAttempted.length === 0 && failed.length === 0) {
      throw new BadRequestException(
        'No pending contacts to send. Everyone in this campaign has already been sent successfully — add more recipients to send to more people.',
      );
    }

    const isRetry = neverAttempted.length === 0 && failed.length > 0;

    if (isRetry) {
      // Only requeue contacts that previously failed; leave already-sent
      // recipients untouched so relaunching never re-emails someone twice.
      await this.db.emailCampaignContact.updateMany({
        where: { campaignId: id, deliveryStatus: 'FAILED' },
        data: {
          deliveryStatus: 'PENDING',
          sentTime: null,
          subject: null,
          bodyHtml: null,
          bodyText: null,
          errorMessage: null,
        },
      });
    }

    // Set campaign status to RUNNING and clear any stale schedule
    await this.db.emailCampaign.update({
      where: { id },
      data: { status: 'RUNNING', scheduledAt: null },
    });

    // Execute sending in the background
    this.runBackgroundSending(campaign.id);

    return {
      success: true,
      message: isRetry
        ? `Retrying ${failed.length} previously failed recipient${failed.length === 1 ? '' : 's'}.`
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

      if (!campaign) return;

      if (!campaign.template) {
        await this.db.emailCampaign.update({
          where: { id: campaignId },
          data: { status: 'FAILED' },
        });
        return;
      }

      const template = campaign.template;
      const isMockSes =
        !settings ||
        !settings.awsAccessKeyId ||
        settings.awsAccessKeyId.toLowerCase().includes('mock') ||
        settings.awsAccessKeyId.toLowerCase().includes('test');

      const senderEmail = settings?.awsSenderEmail?.trim();
      if (!isMockSes && !senderEmail) {
        throw new Error(
          'No sender email configured. Add a Sender Email Address in Settings before launching real campaigns.',
        );
      }
      const senderSource = senderEmail ? `<${senderEmail}>` : '';

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
            await this.sendWithRetry(async () => {
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
                        from: senderSource,
                      }),
                    ),
                  },
                });

                await client!.send(command);
              } else {
                const command = new SendEmailCommand({
                  Source: senderSource,
                  Destination: {
                    ToAddresses: [contact.email],
                  },
                  Message: {
                    Subject: { Data: subject },
                    Body: messageBody,
                  },
                });

                await client!.send(command);
              }
            });

            // Small pacing delay between real sends to stay under SES's
            // per-second sending rate and avoid throttling errors.
            await new Promise((r) => setTimeout(r, 250));

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

  /** Retries a single SES send once after a short backoff on throttling-style errors. */
  private async sendWithRetry(send: () => Promise<unknown>) {
    try {
      await send();
    } catch (err: any) {
      const message = String(err?.name || err?.message || '').toLowerCase();
      const isThrottling =
        message.includes('throttl') || message.includes('rate exceeded');
      if (!isThrottling) throw err;

      await new Promise((r) => setTimeout(r, 1000));
      await send();
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
    from,
  }: {
    to: string;
    subject: string;
    bodyHtml: string;
    bodyText: string;
    attachments: { name: string; contentType: string; contentBase64: string }[];
    from: string;
  }) {
    const mixedBoundary = `mixed_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const altBoundary = `alt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const lines: string[] = [
      `From: ${from}`,
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
