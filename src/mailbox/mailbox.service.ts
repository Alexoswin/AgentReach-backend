import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isEmail } from 'class-validator';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { EmailTrackingConfig } from '../email-tracking/email-tracking.config';
import { newTrackingToken } from '../email-tracking/open-pixel';
import { buildPage, containsRegex, resolvePage } from '../common/pagination';
import type {
  MailAddress,
  MailAttachmentRef,
} from '../schemas/mail-message.schema';
import { MailAttachmentsService } from './mail-attachments.service';
import { MailSendersService } from './mail-senders.service';
import { MailStoreService, contactName } from './mail-store.service';
import { folderFilter, folderSortField } from './mail-folders';
import type { MailFolder } from './mail-folders';
import {
  htmlToText,
  quoteForForward,
  quoteForReply,
  snippetOf,
  withPrefix,
} from './mail-format';
import { encodedSize } from './mime';
import {
  hasSesCredentials,
  SES_MAX_RAW_MESSAGE_BYTES,
  sesReplyDomain,
} from './ses';
import { ListThreadsQueryDto } from './dto/list-threads.dto';
import { BulkThreadsDto, UpdateThreadDto } from './dto/update-thread.dto';
import {
  CreateDraftDto,
  DraftAttachmentDto,
  SendDraftDto,
  UpdateDraftDto,
} from './dto/draft.dto';

const DEFAULT_UNDO_SECONDS = 10;
const MAX_RECIPIENTS = 50;
const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60 * 1000;
const SEARCH_MESSAGE_LIMIT = 500;

const messageTime = (message: any) =>
  new Date(
    message.receivedAt ||
      message.sentAt ||
      message.sendAt ||
      message.createdAt ||
      0,
  ).getTime();

function toThreadItem(thread: any, campaigns: Map<string, any> = new Map()) {
  return {
    id: thread.id,
    subject: thread.subject,
    snippet: thread.snippet,
    participants: thread.participants || [],
    lastMessageAt: thread.lastMessageAt,
    lastActivityAt: thread.lastActivityAt,
    messageCount: thread.messageCount,
    unreadCount: thread.unreadCount,
    hasInbound: thread.hasInbound,
    draftCount: thread.draftCount,
    scheduledCount: thread.scheduledCount,
    hasAttachments: thread.hasAttachments,
    starred: thread.starred,
    archived: thread.archived,
    trashed: thread.trashed,
    labels: thread.labels || [],
    lastDirection: thread.lastDirection,
    lastStatus: thread.lastStatus,
    contactId: thread.contactId || null,
    campaign: thread.campaignId
      ? campaigns.get(thread.campaignId) || {
          id: thread.campaignId,
          name: 'Deleted campaign',
        }
      : null,
  };
}

function toMessageView(message: any) {
  return {
    id: message.id,
    threadId: message.threadId,
    direction: message.direction,
    source: message.source,
    status: message.status,
    from: message.from,
    to: message.to || [],
    cc: message.cc || [],
    bcc: message.direction === 'OUTBOUND' ? message.bcc || [] : [],
    replyTo: message.replyTo,
    subject: message.subject,
    html: message.html,
    text: message.text,
    quotedHtml: message.quotedHtml,
    quotedText: message.quotedText,
    quotedMessageId: message.quotedMessageId,
    snippet: message.snippet,
    attachments: (message.attachments || []).map(
      (attachment: MailAttachmentRef) => ({
        id: attachment.fileId,
        name: attachment.name,
        contentType: attachment.contentType,
        size: attachment.size,
        contentId: attachment.contentId || null,
        inline: Boolean(attachment.inline),
      }),
    ),
    sendAt: message.sendAt,
    scheduled: message.scheduled,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    readAt: message.readAt,
    trackOpens: message.trackOpens,
    openCount: message.openCount,
    firstOpenedAt: message.firstOpenedAt,
    lastOpenedAt: message.lastOpenedAt,
    deliveredAt: message.deliveredAt,
    bouncedAt: message.bouncedAt,
    bounceType: message.bounceType,
    complainedAt: message.complainedAt,
    lastError: message.lastError,
    automated: message.automated,
    campaignId: message.campaignId,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

/** The inbox: conversations, drafts, sending, and the folders around them. */
@Injectable()
export class MailboxService {
  constructor(
    private readonly db: MongoService,
    private readonly settingsService: SettingsService,
    private readonly store: MailStoreService,
    private readonly attachments: MailAttachmentsService,
    private readonly senders: MailSendersService,
    private readonly trackingConfig: EmailTrackingConfig,
  ) {}

  async listThreads(ownerId: string, query: ListThreadsQueryDto) {
    const folder: MailFolder = query.folder || 'inbox';
    const where: Record<string, unknown> = { ownerId, ...folderFilter(folder) };
    if (query.unread === 'true') where.unreadCount = { $gt: 0 };
    if (query.campaignId) where.campaignId = query.campaignId;
    if (query.label) where.labels = query.label;

    const term = query.search?.trim();
    if (term) {
      const pattern = containsRegex(term);
      const matches = await this.db.mailMessage.findMany({
        where: {
          ownerId,
          $or: [
            { subject: pattern },
            { text: pattern },
            { 'from.email': pattern },
            { 'from.name': pattern },
            { 'to.email': pattern },
          ],
        },
        select: { threadId: true },
        take: SEARCH_MESSAGE_LIMIT,
      });
      where.$or = [
        { subject: pattern },
        { snippet: pattern },
        { 'participants.email': pattern },
        { 'participants.name': pattern },
        { _id: { $in: [...new Set(matches.map((m: any) => m.threadId))] } },
      ];
    }

    const { page, limit, skip } = resolvePage(query);
    const [threads, total] = await Promise.all([
      this.db.mailThread.findMany({
        where,
        orderBy: { [folderSortField(folder)]: 'desc', id: 'desc' },
        skip,
        take: limit,
      }),
      this.db.mailThread.count({ where }),
    ]);
    const campaigns = await this.campaignNames(threads);
    return buildPage(
      threads.map((thread: any) => toThreadItem(thread, campaigns)),
      total,
      page,
      limit,
    );
  }

  async counts(ownerId: string) {
    const count = (folder: MailFolder, extra: Record<string, unknown> = {}) =>
      this.db.mailThread.count({
        where: { ownerId, ...folderFilter(folder), ...extra },
      });
    const unread = { unreadCount: { $gt: 0 } };
    const [inbox, campaigns, drafts, scheduled] = await Promise.all([
      count('inbox', unread),
      count('campaigns', unread),
      count('drafts'),
      count('scheduled'),
    ]);
    return { inbox, campaigns, drafts, scheduled };
  }

  async getThread(ownerId: string, id: string) {
    const thread = await this.ownedThread(ownerId, id);
    const messages = await this.db.mailMessage.findMany({
      where: { ownerId, threadId: id, status: { $ne: 'CANCELLED' } },
      orderBy: { createdAt: 'asc' },
    });
    const ordered = [
      ...messages
        .filter((m: any) => m.status !== 'DRAFT')
        .sort((a: any, b: any) => messageTime(a) - messageTime(b)),
      ...messages.filter((m: any) => m.status === 'DRAFT'),
    ];
    const campaigns = await this.campaignNames([thread]);
    const contact = thread.contactId
      ? await this.db.contact.findFirst({
          where: { id: thread.contactId, ownerId },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            company: true,
            jobTitle: true,
          },
        })
      : null;
    return {
      ...toThreadItem(thread, campaigns),
      contact,
      messages: ordered.map(toMessageView),
    };
  }

  async updateThread(ownerId: string, id: string, dto: UpdateThreadDto) {
    const thread = await this.ownedThread(ownerId, id);
    const data: Record<string, unknown> = {};
    if (dto.starred !== undefined) data.starred = dto.starred;
    if (dto.archived !== undefined) data.archived = dto.archived;
    if (dto.trashed !== undefined) data.trashed = dto.trashed;
    if (dto.labels !== undefined) {
      data.labels = [
        ...new Set(dto.labels.map((label) => label.trim()).filter(Boolean)),
      ];
    }
    if (Object.keys(data).length > 0) {
      await this.db.mailThread.update({ where: { id, ownerId }, data });
    }

    if (dto.read !== undefined) await this.setRead(thread, dto.read);
    const updated = await this.store.refreshThread(id);
    return toThreadItem(updated, await this.campaignNames([updated]));
  }

  private async setRead(thread: any, read: boolean) {
    if (read) {
      await this.db.mailMessage.updateMany({
        where: { threadId: thread.id, direction: 'INBOUND', readAt: null },
        data: { readAt: new Date() },
      });
    } else {
      // Like Gmail: the newest message becomes unread.
      const latest = await this.db.mailMessage.findFirst({
        where: { threadId: thread.id, direction: 'INBOUND' },
        orderBy: { receivedAt: 'desc' },
        select: { id: true },
      });
      if (latest) {
        await this.db.mailMessage.update({
          where: { id: latest.id },
          data: { readAt: null },
        });
      }
    }
    // Keeps the campaign's own reply record in step.
    if (thread.campaignContactId) {
      await this.db.emailCampaignContact.updateMany({
        where: { id: thread.campaignContactId, replyStatus: true },
        data: { replyReadAt: read ? new Date() : null },
      });
    }
  }

  async bulkUpdate(ownerId: string, dto: BulkThreadsDto) {
    const updates: Record<string, UpdateThreadDto> = {
      read: { read: true },
      unread: { read: false },
      star: { starred: true },
      unstar: { starred: false },
      archive: { archived: true },
      unarchive: { archived: false },
      trash: { trashed: true },
      untrash: { trashed: false },
    };
    let changed = 0;
    for (const id of new Set(dto.ids)) {
      const thread = await this.db.mailThread.findUnique({
        where: { id, ownerId },
        select: { id: true },
      });
      if (!thread) continue;
      if (dto.action === 'delete') await this.deleteThread(ownerId, id);
      else await this.updateThread(ownerId, id, updates[dto.action]);
      changed += 1;
    }
    return { success: true, changed };
  }

  /**
   * Deletes a trashed conversation's messages for good. The thread itself is
   * kept, empty and in no folder, so a later reply to it still has a home.
   */
  async deleteThread(ownerId: string, id: string) {
    const thread = await this.ownedThread(ownerId, id);
    if (!thread.trashed) {
      throw new BadRequestException(
        'Move the conversation to Trash before deleting it.',
      );
    }
    const messages = await this.db.mailMessage.findMany({
      where: { ownerId, threadId: id, status: { $nin: ['QUEUED', 'SENDING'] } },
      select: { id: true, attachments: true },
    });
    await this.db.mailMessage.deleteMany({
      where: { id: { in: messages.map((m: any) => m.id) } },
    });
    await this.db.mailThread.update({
      where: { id, ownerId },
      data: { starred: false, archived: false, trashed: false, labels: [] },
    });
    await this.store.refreshThread(id);
    await this.attachments.deleteUnreferenced(
      ownerId,
      messages.flatMap((m: any) =>
        (m.attachments || []).map((a: any) => a.fileId),
      ),
    );
    return { success: true };
  }

  async createDraft(ownerId: string, dto: CreateDraftDto) {
    const settings = await this.settingsService.getRawSettings(ownerId);
    const mode = dto.mode || 'new';
    let thread: any = null;
    let base: any = {};

    if (mode !== 'new') {
      if (!dto.sourceMessageId) {
        throw new BadRequestException(
          'Choose the message to reply to or forward.',
        );
      }
      const source = await this.db.mailMessage.findFirst({
        where: { id: dto.sourceMessageId, ownerId },
      });
      if (!source) throw new NotFoundException('Message not found');
      thread = await this.ownedThread(ownerId, source.threadId);
      base = await this.replyDefaults(mode, source, thread, settings);
    }

    if (!thread) {
      thread = await this.db.mailThread.create({
        data: {
          ownerId,
          subject: dto.subject || '',
          contactId: dto.contactId || null,
        },
      });
    }

    const html = dto.html ?? '';
    const message = await this.db.mailMessage.create({
      data: {
        ownerId,
        threadId: thread.id,
        direction: 'OUTBOUND',
        source: 'MANUAL',
        status: 'DRAFT',
        from: {
          email: (dto.from || base.from || settings?.awsSenderEmail || '')
            .trim()
            .toLowerCase(),
          name: settings?.mailFromName?.trim() || null,
        },
        to: await this.toAddresses(ownerId, dto.to, base.to),
        cc: await this.toAddresses(ownerId, dto.cc, base.cc),
        bcc: await this.toAddresses(ownerId, dto.bcc, []),
        subject: dto.subject ?? base.subject ?? '',
        html,
        text: htmlToText(html),
        snippet: snippetOf(htmlToText(html)),
        attachments: dto.attachments
          ? await this.resolveAttachments(ownerId, dto.attachments)
          : base.attachments || [],
        inReplyTo: base.inReplyTo || null,
        references: base.references || [],
        quotedHtml: base.quotedHtml || '',
        quotedText: base.quotedText || '',
        quotedMessageId: base.quotedMessageId || null,
        trackOpens: dto.trackOpens ?? false,
        contactId: thread.contactId || dto.contactId || null,
      },
    });
    await this.store.refreshThread(thread.id);
    return toMessageView(message);
  }

  async updateDraft(ownerId: string, id: string, dto: UpdateDraftDto) {
    const draft = await this.ownedDraft(ownerId, id);
    const data: Record<string, unknown> = {};
    if (dto.to !== undefined)
      data.to = await this.toAddresses(ownerId, dto.to, []);
    if (dto.cc !== undefined)
      data.cc = await this.toAddresses(ownerId, dto.cc, []);
    if (dto.bcc !== undefined)
      data.bcc = await this.toAddresses(ownerId, dto.bcc, []);
    if (dto.subject !== undefined) data.subject = dto.subject;
    if (dto.html !== undefined) {
      data.html = dto.html;
      data.text = htmlToText(dto.html);
      data.snippet = snippetOf(data.text as string);
    }
    if (dto.from !== undefined) {
      data.from = { ...draft.from, email: dto.from.trim().toLowerCase() };
    }
    if (dto.attachments !== undefined) {
      data.attachments = await this.resolveAttachments(
        ownerId,
        dto.attachments,
      );
    }
    if (dto.trackOpens !== undefined) data.trackOpens = dto.trackOpens;

    const updated = await this.db.mailMessage.update({
      where: { id, ownerId, status: 'DRAFT' },
      data,
    });
    if (!updated) throw new BadRequestException('This draft was already sent.');
    await this.store.refreshThread(draft.threadId);
    if (dto.attachments !== undefined) {
      await this.attachments.deleteUnreferenced(
        ownerId,
        (draft.attachments || []).map((a: any) => a.fileId),
      );
    }
    return toMessageView(updated);
  }

  async deleteDraft(ownerId: string, id: string) {
    const draft = await this.ownedDraft(ownerId, id);
    await this.db.mailMessage.delete({
      where: { id, ownerId, status: 'DRAFT' },
    });
    const remaining = await this.db.mailMessage.count({
      where: { threadId: draft.threadId },
    });
    if (remaining === 0) {
      await this.db.mailThread.delete({
        where: { id: draft.threadId, ownerId },
      });
    } else {
      await this.store.refreshThread(draft.threadId);
    }
    await this.attachments.deleteUnreferenced(
      ownerId,
      (draft.attachments || []).map((a: any) => a.fileId),
    );
    return { success: true };
  }

  async sendDraft(ownerId: string, id: string, dto: SendDraftDto) {
    const draft = await this.ownedDraft(ownerId, id);
    const settings = await this.settingsService.getRawSettings(ownerId);
    if (!hasSesCredentials(settings)) {
      throw new BadRequestException(
        'Add your AWS SES credentials in Settings before sending email.',
      );
    }
    const from = await this.senders.assertAllowedFrom(
      settings,
      draft.from?.email || settings.awsSenderEmail,
    );

    const recipients: MailAddress[] = [
      ...(draft.to || []),
      ...(draft.cc || []),
      ...(draft.bcc || []),
    ];
    if (recipients.length === 0) {
      throw new BadRequestException('Add at least one recipient.');
    }
    const invalid = recipients.filter((address) => !isEmail(address.email));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `These are not valid email addresses: ${invalid.map((a) => a.email).join(', ')}`,
      );
    }
    if (recipients.length > MAX_RECIPIENTS) {
      throw new BadRequestException(
        `An email can go to at most ${MAX_RECIPIENTS} people. Use a campaign for more.`,
      );
    }
    const size = encodedSize({
      html: `${draft.html || ''}${draft.quotedHtml || ''}`,
      text: `${draft.text || ''}${draft.quotedText || ''}`,
      attachmentBytes: (draft.attachments || []).reduce(
        (total: number, attachment: MailAttachmentRef) =>
          total + (attachment.size || 0),
        0,
      ),
    });
    if (size > SES_MAX_RAW_MESSAGE_BYTES) {
      throw new BadRequestException(
        'This email is over the 10 MB AWS SES accepts once encoded. Remove an attachment or share a link instead.',
      );
    }

    let sendAt = new Date(
      Date.now() + (dto.undoSeconds ?? DEFAULT_UNDO_SECONDS) * 1000,
    );
    if (dto.sendAt) {
      sendAt = new Date(dto.sendAt);
      const ahead = sendAt.getTime() - Date.now();
      if (Number.isNaN(ahead) || ahead < 30 * 1000) {
        throw new BadRequestException(
          'Pick a time at least a minute from now.',
        );
      }
      if (ahead > MAX_SCHEDULE_MS) {
        throw new BadRequestException(
          'Emails can be scheduled up to a year ahead.',
        );
      }
    }

    const replyDomain = sesReplyDomain(settings);
    const html = draft.html || '';
    const queued = await this.db.mailMessage.updateOneRaw(
      { _id: id, ownerId, status: 'DRAFT' },
      {
        $set: {
          status: 'QUEUED',
          sendAt,
          scheduled: Boolean(dto.sendAt),
          from: {
            email: from,
            name: settings?.mailFromName?.trim() || draft.from?.name || null,
          },
          replyTo: replyDomain
            ? this.trackingConfig.replyToAddress(draft.threadId, replyDomain)
            : null,
          trackingToken:
            draft.trackOpens && html.trim() ? newTrackingToken() : null,
          attempts: 0,
          lastError: null,
        },
      },
    );
    if (queued.count === 0) {
      throw new BadRequestException('This draft was already sent.');
    }
    await this.store.refreshThread(draft.threadId);
    return {
      id,
      threadId: draft.threadId,
      status: 'QUEUED',
      sendAt,
      scheduled: Boolean(dto.sendAt),
    };
  }

  /** Undo send, or cancel a scheduled send: the email goes back to a draft. */
  async cancelSend(ownerId: string, id: string) {
    const message = await this.db.mailMessage.findFirst({
      where: { id, ownerId, source: 'MANUAL' },
      select: { id: true, threadId: true },
    });
    if (!message) throw new NotFoundException('Email not found');
    const reverted = await this.db.mailMessage.updateOneRaw(
      { _id: id, ownerId, status: 'QUEUED' },
      {
        $set: {
          status: 'DRAFT',
          sendAt: null,
          scheduled: false,
          trackingToken: null,
          replyTo: null,
        },
      },
    );
    if (reverted.count === 0) {
      throw new BadRequestException(
        'Too late to undo: this email is already sent.',
      );
    }
    await this.store.refreshThread(message.threadId);
    const draft = await this.db.mailMessage.findUnique({ where: { id } });
    return toMessageView(draft);
  }

  async senderOptions(ownerId: string) {
    const settings = await this.settingsService.getRawSettings(ownerId);
    return {
      ...(await this.senders.options(settings)),
      sesConfigured: hasSesCredentials(settings),
      replyTrackingActive: Boolean(sesReplyDomain(settings)),
    };
  }

  async uploadAttachment(ownerId: string, file: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose a file to attach.');
    }
    const saved = await this.attachments.save(ownerId, {
      name: file.originalname || 'attachment',
      contentType: file.mimetype || 'application/octet-stream',
      content: file.buffer,
    });
    return {
      id: saved.fileId,
      name: saved.name,
      contentType: saved.contentType,
      size: saved.size,
    };
  }

  async contactContext(ownerId: string, email: string) {
    const address = (email || '').trim().toLowerCase();
    const contact = address
      ? await this.db.contact.findFirst({
          where: { ownerId, email: address },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            company: true,
            jobTitle: true,
            phoneNumber: true,
            linkedinUrl: true,
            notes: true,
          },
        })
      : null;
    if (!contact) return { contact: null, campaigns: [], calls: [] };

    const [rows, calls] = await Promise.all([
      this.db.emailCampaignContact.findMany({
        where: { ownerId, contactId: contact.id },
        include: {
          campaign: { select: { id: true, name: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.db.callHistory.findMany({
        where: { ownerId, contactId: contact.id },
        select: {
          id: true,
          outcome: true,
          duration: true,
          timestamp: true,
          summary: true,
        },
        orderBy: { timestamp: 'desc' },
        take: 5,
      }),
    ]);
    return {
      contact,
      campaigns: rows.map((row: any) => ({
        id: row.campaign?.id || row.campaignId,
        name: row.campaign?.name || 'Deleted campaign',
        status: row.campaign?.status || null,
        deliveryStatus: row.deliveryStatus,
        sentTime: row.sentTime,
        opened: Boolean(row.openStatus),
        replied: Boolean(row.replyStatus),
      })),
      calls,
    };
  }

  private async replyDefaults(
    mode: 'reply' | 'replyAll' | 'forward',
    source: any,
    thread: any,
    settings: any,
  ) {
    const replyDomain = sesReplyDomain(settings);
    const lastOutbound = await this.db.mailMessage.findFirst({
      where: {
        threadId: thread.id,
        direction: 'OUTBOUND',
        status: { $nin: ['DRAFT', 'CANCELLED'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { from: true },
    });
    const own = new Set(
      [
        settings?.awsSenderEmail,
        lastOutbound?.from?.email,
        source.direction === 'OUTBOUND' ? source.from?.email : null,
      ]
        .filter(Boolean)
        .map((email: string) => email.toLowerCase()),
    );
    const isOwn = (email: string) =>
      own.has(email) ||
      Boolean(replyDomain && email.endsWith(`@${replyDomain}`));
    const clean = (list: MailAddress[] = []) =>
      list.filter(
        (address) => address?.email && !isOwn(address.email.toLowerCase()),
      );

    let to: MailAddress[] = [];
    let cc: MailAddress[] = [];
    if (mode !== 'forward') {
      to =
        source.direction === 'INBOUND'
          ? clean([
              source.replyTo
                ? { email: source.replyTo, name: source.from?.name }
                : source.from,
            ])
          : clean(source.to);
      if (mode === 'replyAll') {
        const taken = new Set(to.map((address) => address.email.toLowerCase()));
        cc = clean([...(source.to || []), ...(source.cc || [])]).filter(
          (address) => !taken.has(address.email.toLowerCase()),
        );
      }
    }

    const date = new Date(messageTime(source));
    const original = {
      html: [source.html, source.quotedHtml]
        .filter((part) => part?.trim())
        .join('<br>'),
      text: [source.text, source.quotedText]
        .filter((part) => part?.trim())
        .join('\n\n'),
      from: source.from,
      to: source.to,
      subject: source.subject,
      date,
    };
    const quoted =
      mode === 'forward' ? quoteForForward(original) : quoteForReply(original);
    return {
      to,
      cc,
      from:
        source.direction === 'OUTBOUND'
          ? source.from?.email
          : lastOutbound?.from?.email || settings?.awsSenderEmail,
      subject: withPrefix(
        mode === 'forward' ? 'Fwd' : 'Re',
        source.subject || thread.subject,
      ),
      inReplyTo: mode === 'forward' ? null : source.messageIdHeader || null,
      references:
        mode === 'forward'
          ? []
          : [...(source.references || []), source.messageIdHeader]
              .filter(Boolean)
              .slice(-20),
      quotedHtml: quoted.quotedHtml,
      quotedText: quoted.quotedText,
      quotedMessageId: source.id,
      attachments:
        mode === 'forward'
          ? (source.attachments || []).filter(
              (attachment: MailAttachmentRef) => !attachment.inline,
            )
          : [],
    };
  }

  /** Addresses as typed, with names filled in from matching contacts. */
  private async toAddresses(
    ownerId: string,
    typed: string[] | undefined,
    fallback: MailAddress[] = [],
  ): Promise<MailAddress[]> {
    if (typed === undefined) return fallback;
    const emails = [
      ...new Set(
        typed.map((value) => parseAddress(value)).filter(Boolean) as string[],
      ),
    ];
    if (emails.length === 0) return [];
    const contacts = await this.db.contact.findMany({
      where: { ownerId, email: { in: emails } },
      select: { email: true, firstName: true, lastName: true },
    });
    const names = new Map(contacts.map((c: any) => [c.email, contactName(c)]));
    const known = new Map(
      fallback.map((a) => [a.email.toLowerCase(), a.name || null]),
    );
    return emails.map((email) => ({
      email,
      name: names.get(email) || known.get(email) || null,
    }));
  }

  private async resolveAttachments(
    ownerId: string,
    refs: DraftAttachmentDto[],
  ) {
    const resolved: MailAttachmentRef[] = [];
    for (const ref of refs) {
      const file = await this.attachments.find(ownerId, ref.fileId);
      if (!file)
        throw new BadRequestException(
          'An attachment could not be found. Upload it again.',
        );
      resolved.push({
        fileId: ref.fileId,
        name: ref.name?.trim() || file.filename,
        contentType: file.metadata?.contentType || 'application/octet-stream',
        size: file.length,
      });
    }
    return resolved;
  }

  private async campaignNames(threads: any[]) {
    const ids = [...new Set(threads.map((t) => t?.campaignId).filter(Boolean))];
    const campaigns = ids.length
      ? await this.db.emailCampaign.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    return new Map<string, any>(campaigns.map((c: any) => [c.id, c]));
  }

  private async ownedThread(ownerId: string, id: string) {
    const thread = await this.db.mailThread.findUnique({
      where: { id, ownerId },
    });
    if (!thread) throw new NotFoundException('Conversation not found');
    return thread;
  }

  private async ownedDraft(ownerId: string, id: string) {
    const draft = await this.db.mailMessage.findFirst({
      where: { id, ownerId },
    });
    if (!draft) throw new NotFoundException('Draft not found');
    if (draft.status !== 'DRAFT') {
      throw new BadRequestException('This draft was already sent.');
    }
    return draft;
  }
}

/** "Jane <jane@acme.com>" or "jane@acme.com" → "jane@acme.com". */
export function parseAddress(value: string) {
  const match = /<([^<>]+)>\s*$/.exec(value || '');
  return (match ? match[1] : value || '').trim().toLowerCase() || null;
}
