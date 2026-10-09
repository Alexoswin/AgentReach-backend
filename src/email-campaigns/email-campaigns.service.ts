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
import { SettingsService } from '../settings/settings.service';

/** AWS SES hard limit on a single raw (MIME) message, after base64 encoding. */
const SES_MAX_RAW_MESSAGE_BYTES = 10 * 1024 * 1024;

@Injectable()
export class EmailCampaignsService {
  constructor(
    private db: MongoService,
    private settingsService: SettingsService,
  ) {}

  async findAll(userId: string) {
    const campaigns = await this.db.emailCampaign.findMany({
      where: { ownerId: userId },
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

  async findOne(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
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

  async create(dto: CreateCampaignDto, userId: string) {
    if (dto.templateId) {
      await this.assertTemplateExists(dto.templateId, userId);
    }

    return this.db.emailCampaign.create({
      data: { ...this.withNormalizedCopyLists(dto), ownerId: userId },
    });
  }

  async update(id: string, dto: UpdateCampaignDto, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (dto.templateId) {
      await this.assertTemplateExists(dto.templateId, userId);
    }

    return this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: this.withNormalizedCopyLists(dto),
    });
  }

  /**
   * Lower-cases and de-duplicates the CC/BCC lists, and drops any address that
   * appears in both. A duplicate address means SES delivers the same message
   * twice to one mailbox, which reads as a bug to the recipient and inflates
   * the complaint rate that governs the whole sending identity.
   */
  private withNormalizedCopyLists<
    T extends { cc?: string[]; bcc?: string[] },
  >(dto: T): T {
    const normalize = (list?: string[]) =>
      Array.from(
        new Set((list || []).map((entry) => entry.trim().toLowerCase())),
      ).filter(Boolean);

    const next: T = { ...dto };

    if (dto.cc !== undefined) next.cc = normalize(dto.cc);
    if (dto.bcc !== undefined) {
      const cc = new Set(next.cc ?? []);
      // CC wins when an address is on both lists — it is the visible one, so
      // silently dropping it from CC would change what recipients see.
      next.bcc = normalize(dto.bcc).filter((entry) => !cc.has(entry));
    }

    return next;
  }

  /**
   * Re-sends the whole campaign, including recipients who already received it.
   *
   * `launchCampaign` deliberately never re-emails a successful recipient, so a
   * finished campaign cannot be restarted through it. This is the explicit
   * opt-in for "send the whole thing again" — the caller is responsible for
   * confirming that duplicate delivery is intended.
   */
  async relaunchCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
      include: { template: true, contacts: true },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (!campaign.template) {
      throw new BadRequestException(
        'Cannot relaunch a campaign without an email template',
      );
    }
    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Campaign is already running');
    }
    if (campaign.contacts.length === 0) {
      throw new BadRequestException('No contacts in this campaign');
    }

    this.assertMessageFitsSesLimit(campaign.template);

    // Reset every recipient, not just the failed ones.
    await this.db.emailCampaignContact.updateMany({
      where: { campaignId: id },
      data: {
        deliveryStatus: 'PENDING',
        sentTime: null,
        subject: null,
        bodyHtml: null,
        bodyText: null,
        errorMessage: null,
      },
    });

    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'RUNNING', scheduledAt: null, launchedBy: userId },
    });

    this.runBackgroundSending(campaign.id);

    const count = campaign.contacts.length;
    return {
      success: true,
      message: `Re-sending this campaign to all ${count} recipient${count === 1 ? '' : 's'}.`,
    };
  }

  /**
   * SES rejects raw messages larger than 10 MB *after* base64 encoding. Without
   * this check the campaign launches happily and then fails per-contact with an
   * opaque SES error, marking every recipient FAILED and burning send quota on
   * a message that could never have been delivered.
   */
  private assertMessageFitsSesLimit(template: {
    subject?: string;
    bodyHtml?: string;
    bodyText?: string;
    attachments?: { name: string; contentBase64: string }[];
  }) {
    const attachments = template.attachments || [];
    if (attachments.length === 0) return;

    // What actually travels is the base64 text, not the decoded bytes.
    const encodedBytes = attachments.reduce(
      (total, attachment) =>
        total + (attachment.contentBase64?.replace(/\s/g, '').length || 0),
      0,
    );
    const bodyBytes =
      Buffer.byteLength(template.bodyHtml || '', 'utf8') +
      Buffer.byteLength(template.bodyText || '', 'utf8');
    // MIME boundaries, headers and CRLF line breaks every 76 chars.
    const overheadBytes = Math.ceil(encodedBytes / 76) * 2 + 2048;
    const totalBytes = encodedBytes + bodyBytes + overheadBytes;

    if (totalBytes > SES_MAX_RAW_MESSAGE_BYTES) {
      const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      throw new BadRequestException(
        `This email is about ${mb(totalBytes)} once encoded for sending, which is over ` +
          `the ${mb(SES_MAX_RAW_MESSAGE_BYTES)} limit AWS SES accepts. ` +
          'Remove an attachment or link to the file instead.',
      );
    }
  }

  private async assertTemplateExists(templateId: string, userId: string) {
    const template = await this.db.template.findUnique({
      where: { id: templateId, ownerId: userId },
    });
    if (!template) {
      throw new BadRequestException('Template not found');
    }
  }

  async remove(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.delete({
      where: { id, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    return campaign;
  }

  async addContacts(campaignId: string, dto: AddContactsDto, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id: campaignId, ownerId: userId },
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
        where: { id: { in: uniqueContactIds }, ownerId: userId },
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
            ownerId: userId,
            campaignId,
            contactId,
            deliveryStatus: 'PENDING',
          },
        }),
      ),
    );

    return { success: true, addedCount: contactIdsToAdd.length };
  }

  async removeContact(campaignId: string, contactId: string, userId: string) {
    const record = await this.db.emailCampaignContact.findFirst({
      where: { campaignId, contactId, ownerId: userId },
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

  async scheduleCampaign(id: string, scheduledAt: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
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
      where: { id, ownerId: userId },
      data: { status: 'SCHEDULED', scheduledAt: when, launchedBy: userId },
    });

    return {
      success: true,
      scheduledAt: when.toISOString(),
      message: `Campaign scheduled for ${when.toISOString()}`,
    };
  }

  async unscheduleCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'DRAFT', scheduledAt: null },
    });

    return { success: true, message: 'Schedule cancelled' };
  }

  /** Every owner's SCHEDULED campaigns whose scheduledAt is due (for the cron). */
  async findDueScheduled() {
    return this.db.emailCampaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
    });
  }

  // userId is the owner, whose SES credentials send the campaign. It is
  // stored as launchedBy because sending continues in the background.
  async launchCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
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

    this.assertMessageFitsSesLimit(campaign.template);

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
      where: { id, ownerId: userId },
      data: { status: 'RUNNING', scheduledAt: null, launchedBy: userId },
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
      const settings = await this.settingsService.getRawSettings(
        campaign.launchedBy,
      );
      if (!settings?.awsAccessKeyId || !settings?.awsSecretAccessKey) {
        throw new Error(
          'AWS SES is not configured. Add your SES credentials in Settings before launching campaigns.',
        );
      }

      const senderEmail = settings.awsSenderEmail?.trim();
      if (!senderEmail) {
        throw new Error(
          'No sender email configured. Add a Sender Email Address in Settings before launching real campaigns.',
        );
      }
      const senderSource = `<${senderEmail}>`;
      const ccAddresses: string[] = (campaign.cc || [])
        .filter(Boolean)
        .map((entry: string) => entry.trim().toLowerCase());
      const bccAddresses: string[] = (campaign.bcc || [])
        .filter(Boolean)
        .map((entry: string) => entry.trim().toLowerCase());

      const client = new SESClient({
        region: settings.awsRegion || 'us-east-1',
        credentials: {
          accessKeyId: settings.awsAccessKeyId,
          secretAccessKey: settings.awsSecretAccessKey,
        },
      });

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

        // A contact who also sits on the campaign CC/BCC list would otherwise
        // receive the same email twice. Drop them from the copy lists for their
        // own send only — other recipients still copy them as configured.
        const recipient = (contact.email || '').trim().toLowerCase();
        const contactCc = ccAddresses.filter((entry) => entry !== recipient);
        const contactBcc = bccAddresses.filter((entry) => entry !== recipient);

        const subject = this.interpolate(template.subject, contact);
        const bodyHtml = this.interpolate(template.bodyHtml, contact, {
          html: true,
        });
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

          await this.sendWithRetry(async () => {
            if (attachments.length > 0) {
              const command = new SendRawEmailCommand({
                Destinations: [contact.email, ...contactCc, ...contactBcc],
                RawMessage: {
                  Data: Buffer.from(
                    this.buildRawEmail({
                      to: contact.email,
                      cc: contactCc,
                      subject,
                      bodyHtml,
                      bodyText,
                      attachments,
                      from: senderSource,
                    }),
                  ),
                },
              });

              await client.send(command);
            } else {
              const command = new SendEmailCommand({
                Source: senderSource,
                Destination: {
                  ToAddresses: [contact.email],
                  CcAddresses: contactCc.length ? contactCc : undefined,
                  BccAddresses: contactBcc.length ? contactBcc : undefined,
                },
                Message: {
                  Subject: { Data: subject },
                  Body: messageBody,
                },
              });

              await client.send(command);
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

  // Contact data comes from user imports, so in HTML bodies it is escaped
  // rather than trusted as markup. Unknown placeholders are dropped.
  private interpolate(
    templateString: string,
    contact: any,
    { html = false }: { html?: boolean } = {},
  ): string {
    if (!templateString) return '';

    const values: Record<string, unknown> = {};
    if (contact.customFields) {
      try {
        Object.assign(values, JSON.parse(contact.customFields));
      } catch {
        // Ignore JSON errors
      }
    }
    Object.assign(values, {
      firstName: contact.firstName,
      lastName: contact.lastName,
      company: contact.company,
      jobTitle: contact.jobTitle,
      email: contact.email,
    });

    return templateString.replace(/\{\{(.*?)\}\}/g, (_, key: string) => {
      const value = Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : '';
      const text =
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
          ? String(value)
          : '';
      return html ? escapeHtml(text) : text;
    });
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
    cc,
    subject,
    bodyHtml,
    bodyText,
    attachments,
    from,
  }: {
    to: string;
    cc?: string[];
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
      `To: ${stripLineBreaks(to)}`,
      ...(cc && cc.length > 0 ? [`Cc: ${stripLineBreaks(cc.join(', '))}`] : []),
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

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Keeps a value from starting a new header line in the raw MIME message.
function stripLineBreaks(value: string) {
  return value.replace(/[\r\n]+/g, ' ');
}
