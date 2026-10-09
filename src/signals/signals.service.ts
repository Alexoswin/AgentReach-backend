import { BadRequestException, Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { IngestionService } from './ingestion.service';
import { TriggerService } from './trigger.service';
import { PlaybooksService } from './playbooks.service';
import { SchedulerService } from './scheduler.service';
import { SesBounceCollector } from './collectors/ses-bounce.collector';
import { CreateManualSignalDto } from './dto/create-manual-signal.dto';
import { ReviewMatchDto } from './dto/review-match.dto';
import { IngestBounceDto } from './dto/ingest-bounce.dto';
import { SIGNAL_TYPE_LABELS, SignalType } from './signal.types';

/**
 * Controller-facing facade: feed, review queue, manual signals, bounce
 * ingestion, and the triggered-vs-manual analytics comparison.
 */
@Injectable()
export class SignalsService {
  constructor(
    private readonly db: MongoService,
    private readonly ingestion: IngestionService,
    private readonly trigger: TriggerService,
    private readonly playbooks: PlaybooksService,
    private readonly scheduler: SchedulerService,
    private readonly sesBounce: SesBounceCollector,
  ) {}

  /** Signal feed with matched-contact counts and fired-playbook badges. */
  async getFeed(
    userId: string,
    filters: { type?: string; status?: string } = {},
  ) {
    const signals = await this.db.signal.findMany({
      where: {
        ownerId: userId,
        ...(filters.type ? { type: filters.type } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
    });

    const allMatches = await this.db.signalMatch.findMany({
      where: {
        ownerId: userId,
        signalId: { in: signals.map((s) => s.id) },
      },
    });
    const matchesBySignal = new Map<string, any[]>();
    for (const m of allMatches) {
      const list = matchesBySignal.get(m.signalId) || [];
      list.push(m);
      matchesBySignal.set(m.signalId, list);
    }

    return signals.map((s) => {
      const matches = matchesBySignal.get(s.id) || [];
      return {
        id: s.id,
        type: s.type,
        typeLabel: SIGNAL_TYPE_LABELS[s.type] || s.type,
        title: s.title,
        summary: s.summary,
        url: s.url,
        source: s.source,
        companyName: s.companyName,
        companyDomain: s.companyDomain,
        occurredAt: s.occurredAt,
        confidence: s.classification?.confidence || 'low',
        matchedContacts: matches.length,
        triggeredCount: matches.filter((m) => m.status === 'triggered').length,
        pendingCount: matches.filter(
          (m) => m.status === 'pending-review' && m.playbookId,
        ).length,
      };
    });
  }

  /** Pending, actionable matches (a playbook wants to fire, awaiting review). */
  async getReviewQueue(userId: string) {
    const pending = await this.db.signalMatch.findMany({
      where: {
        ownerId: userId,
        status: 'pending-review',
        playbookId: { $ne: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // One query per related collection instead of three per pending match.
    const idsOf = (key: string) => [...new Set(pending.map((m) => m[key]))];
    const [signals, contacts, playbooks] = await Promise.all([
      this.db.signal.findMany({
        where: { ownerId: userId, id: { in: idsOf('signalId') } },
      }),
      this.db.contact.findMany({
        where: { ownerId: userId, id: { in: idsOf('contactId') } },
      }),
      this.db.playbook.findMany({
        where: { ownerId: userId, id: { in: idsOf('playbookId') } },
      }),
    ]);
    const signalById = new Map(signals.map((x) => [x.id, x]));
    const contactById = new Map(contacts.map((x) => [x.id, x]));
    const playbookById = new Map(playbooks.map((x) => [x.id, x]));

    const results = [];
    for (const match of pending) {
      const signal = signalById.get(match.signalId);
      const contact = contactById.get(match.contactId);
      const playbook = playbookById.get(match.playbookId);
      if (!signal || !contact || !playbook) continue;

      const preview = await this.trigger.renderPreview(
        playbook.templateId,
        signal,
        userId,
      );

      results.push({
        matchId: match.id,
        confidence: match.confidence,
        signal: {
          id: signal.id,
          type: signal.type,
          typeLabel: SIGNAL_TYPE_LABELS[signal.type] || signal.type,
          title: signal.title,
          summary: signal.summary,
          url: signal.url,
          companyName: signal.companyName,
          occurredAt: signal.occurredAt,
        },
        contact: {
          id: contact.id,
          name: `${contact.firstName} ${contact.lastName}`.trim(),
          email: contact.email,
          company: contact.company,
          jobTitle: contact.jobTitle,
        },
        playbook: { id: playbook.id, name: playbook.name },
        preview,
      });
    }
    return results;
  }

  async reviewMatch(matchId: string, dto: ReviewMatchDto, userId: string) {
    const match = await this.db.signalMatch.findUnique({
      where: { id: matchId, ownerId: userId },
    });
    if (!match) throw new BadRequestException('Match not found');
    if (match.status !== 'pending-review') {
      throw new BadRequestException('Match has already been reviewed');
    }

    if (dto.action === 'reject') {
      await this.db.signalMatch.update({
        where: { id: matchId, ownerId: userId },
        data: { status: 'rejected', note: dto.note },
      });
      return { success: true, outcome: 'rejected' };
    }

    // approve → trigger
    if (!match.playbookId) {
      throw new BadRequestException('This match has no playbook to launch');
    }
    const signal = await this.db.signal.findUnique({
      where: { id: match.signalId, ownerId: userId },
    });
    const playbook = await this.playbooks.findOne(match.playbookId, userId);
    if (!signal) throw new BadRequestException('Signal not found');

    // Sent by the owner (the approving user), with their SES credentials.
    const result = await this.trigger.trigger(
      signal,
      match.contactId,
      playbook,
      matchId,
    );
    return { success: result.outcome === 'triggered', ...result };
  }

  async createManualSignal(dto: CreateManualSignalDto, userId: string) {
    const domain =
      dto.companyDomain?.toLowerCase().trim() ||
      dto.contactEmail?.split('@')[1]?.toLowerCase().trim();

    const watch = domain
      ? await this.db.companyWatch.findUnique({
          where: { domain, ownerId: userId },
        })
      : null;

    const id = await this.ingestion.ingest(
      {
        source: 'manual',
        companyDomain: domain,
        companyName: dto.companyName,
        title: dto.title,
        summary: dto.summary,
        url: dto.url,
        occurredAt: new Date(),
        suggestedType: (dto.type as SignalType) || 'manual',
      },
      userId,
      watch?.id,
    );

    return { success: !!id, signalId: id, deduped: !id };
  }

  /** SES bounce/complaint webhook — infers job-change signals from telemetry. */
  async ingestBounce(dto: IngestBounceDto, userId: string) {
    if (!this.sesBounce.looksLikeJobChange(dto.bounceMessage || '')) {
      return { success: false, reason: 'not-a-job-change-signal' };
    }
    const raw = this.sesBounce.buildSignal({
      email: dto.email,
      companyName: dto.companyName,
      companyDomain: dto.companyDomain,
      bounceMessage: dto.bounceMessage,
    });
    const watch = raw.companyDomain
      ? await this.db.companyWatch.findUnique({
          where: { domain: raw.companyDomain, ownerId: userId },
        })
      : null;
    const id = await this.ingestion.ingest(raw, userId, watch?.id);
    return { success: !!id, signalId: id };
  }

  async runPollNow(userId: string) {
    return this.scheduler.runPoll(userId);
  }

  /** Triggered-vs-manual performance comparison for the dashboard. */
  async getStats(userId: string) {
    const owned = { where: { ownerId: userId } };
    const triggered = await this.db.triggeredOutreach.findMany({
      ...owned,
      select: { campaignId: true },
    });
    const triggeredCampaignIds = new Set(
      triggered.map((t) => t.campaignId).filter(Boolean),
    );

    const allContacts = await this.db.emailCampaignContact.findMany({
      ...owned,
      select: {
        campaignId: true,
        deliveryStatus: true,
        sentTime: true,
        openStatus: true,
        replyStatus: true,
      },
    });
    const rate = (rows: any[]) => {
      const sent = rows.filter(
        (r) => r.deliveryStatus === 'SENT' || r.sentTime,
      );
      const sentCount = sent.length || 0;
      const opens = sent.filter((r) => r.openStatus).length;
      const replies = sent.filter((r) => r.replyStatus).length;
      return {
        sent: sentCount,
        openRate: sentCount ? Math.round((opens / sentCount) * 100) : 0,
        replyRate: sentCount ? Math.round((replies / sentCount) * 100) : 0,
      };
    };

    const triggeredRows = allContacts.filter((c) =>
      triggeredCampaignIds.has(c.campaignId),
    );
    const manualRows = allContacts.filter(
      (c) => !triggeredCampaignIds.has(c.campaignId),
    );

    const activeWatches = await this.db.companyWatch.count({
      where: { ownerId: userId, status: 'active' },
    });

    return {
      watchedCompanies: activeWatches,
      totalSignals: await this.db.signal.count(owned),
      triggeredOutreach: triggered.length,
      triggered: rate(triggeredRows),
      manual: rate(manualRows),
    };
  }
}
