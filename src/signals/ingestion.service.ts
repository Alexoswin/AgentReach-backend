import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { MongoService } from '../mongo.service';
import { SignalClassifierService } from './signal-classifier.service';
import { ContactMatch, MatchingService } from './matching.service';
import { PlaybooksService } from './playbooks.service';
import { TriggerService } from './trigger.service';
import { Confidence, RawSignal } from './signal.types';

const DEDUP_WINDOW_DAYS = 14;
// Two or more human rejections of the same (contact, company) pairing means
// the match is a recurring false positive — stop resurfacing it for review.
const REJECTION_SUPPRESSION_THRESHOLD = 2;
// A second source reporting on the same company within this window makes the
// signal materially more credible.
const CORROBORATION_WINDOW_DAYS = 7;

const CONFIDENCE_BUMP: Record<Confidence, Confidence> = {
  low: 'medium',
  medium: 'high',
  high: 'high',
};

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly db: MongoService,
    private readonly classifier: SignalClassifierService,
    private readonly matching: MatchingService,
    private readonly playbooks: PlaybooksService,
    private readonly trigger: TriggerService,
  ) {}

  /**
   * Full pipeline for one raw signal: classify → dedup → persist → corroborate
   * → match → evaluate playbooks (auto-trigger or queue for review).
   * Returns the persisted signal id, or null if it was a duplicate.
   */
  async ingest(raw: RawSignal, watchId?: string): Promise<string | null> {
    const hash = this.hash(raw);

    // Dedup within the rolling window.
    const cutoff = new Date(
      Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const existing = await this.db.signal.findFirst({ where: { hash } });
    if (existing && new Date(existing.createdAt) >= cutoff) {
      return null;
    }

    const classification = await this.classifier.classify(raw);
    const corroboration = await this.findCorroboration(raw);

    const signal = await this.db.signal.create({
      data: {
        watchId,
        companyDomain: raw.companyDomain,
        companyName: raw.companyName,
        type: classification.type,
        title: raw.title,
        summary: classification.summary,
        url: raw.url,
        source: raw.source,
        occurredAt: raw.occurredAt || new Date(),
        classification: {
          confidence: corroboration.length
            ? CONFIDENCE_BUMP[classification.confidence]
            : classification.confidence,
          entities: classification.entities,
          ...(corroboration.length
            ? { corroboratedBy: corroboration.map((s) => s.id) }
            : {}),
        },
        hash,
        raw: raw.raw || {},
      },
    });

    if (watchId) await this.markWatchSignal(watchId, raw.source);

    await this.matchAndEvaluate(signal);
    return signal.id;
  }

  /**
   * Independent recent signals for the same company from a *different* source
   * — cross-source agreement is a stronger buy indicator than either alone.
   */
  private async findCorroboration(raw: RawSignal): Promise<any[]> {
    if (!raw.companyDomain) return [];
    const cutoff = new Date(
      Date.now() - CORROBORATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    const recent = await this.db.signal.findMany({
      where: { companyDomain: raw.companyDomain, occurredAt: { gte: cutoff } },
    });
    return recent.filter(
      (s: any) => s.source !== raw.source && s.type !== 'news-other',
    );
  }

  /** Record when a source last produced a real signal (watch health). */
  private async markWatchSignal(watchId: string, source: string) {
    try {
      const watch = await this.db.companyWatch.findUnique({
        where: { id: watchId },
      });
      if (!watch) return;
      await this.db.companyWatch.update({
        where: { id: watchId },
        data: {
          lastSignalAt: {
            ...(watch.lastSignalAt || {}),
            [source]: new Date().toISOString(),
          },
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not mark watch signal health: ${(err as Error).message}`,
      );
    }
  }

  /** Match a persisted signal to contacts and run playbooks over each match. */
  private async matchAndEvaluate(signal: any): Promise<void> {
    // 'news-other' / low-value noise is stored but never matched/triggered.
    if (signal.type === 'news-other') return;

    const contactMatches = await this.matching.matchSignalToContacts(signal);
    if (contactMatches.length === 0) return;

    const contactIds = contactMatches.map((cm) => cm.contactId);
    const [contacts, suppressed] = await Promise.all([
      this.db.contact.findMany({ where: { id: { $in: contactIds } } }),
      this.findSuppressedContacts(signal.companyDomain, contactIds),
    ]);
    const contactById = new Map(contacts.map((c: any) => [c.id, c]));

    for (const cm of contactMatches) {
      const contact = contactById.get(cm.contactId);
      if (!contact) continue;

      // Learning loop: a pairing the reviewer keeps rejecting is recorded as
      // suppressed (visible, inert) instead of re-entering the review queue.
      if (suppressed.has(cm.contactId)) {
        await this.upsertMatch(signal, cm, null, 'suppressed');
        continue;
      }

      const playbooks = await this.playbooks.findMatchingPlaybooks(
        signal.type,
        contact,
      );

      // No playbook: still record the match so it surfaces in the feed.
      if (playbooks.length === 0) {
        await this.upsertMatch(signal, cm, null);
        continue;
      }

      for (const playbook of playbooks) {
        const shouldAutoFire =
          playbook.mode === 'auto' && cm.confidence === 'high';

        const match = await this.upsertMatch(
          signal,
          cm,
          playbook.id,
          shouldAutoFire ? 'approved' : 'pending-review',
        );

        if (shouldAutoFire) {
          try {
            await this.trigger.trigger(
              signal,
              cm.contactId,
              playbook,
              match.id,
            );
          } catch (err) {
            this.logger.error(
              `Auto-trigger failed for signal ${signal.id}: ${(err as Error).message}`,
            );
          }
        }
      }
    }
  }

  /** Contact ids whose pairing with this company was repeatedly rejected. */
  private async findSuppressedContacts(
    companyDomain: string | undefined,
    contactIds: string[],
  ): Promise<Set<string>> {
    if (!companyDomain || contactIds.length === 0) return new Set();
    const rejected = await this.db.signalMatch.findMany({
      where: {
        companyDomain,
        status: 'rejected',
        contactId: { $in: contactIds },
      },
    });
    const counts = new Map<string, number>();
    for (const m of rejected) {
      counts.set(m.contactId, (counts.get(m.contactId) || 0) + 1);
    }
    return new Set(
      [...counts.entries()]
        .filter(([, n]) => n >= REJECTION_SUPPRESSION_THRESHOLD)
        .map(([id]) => id),
    );
  }

  private async upsertMatch(
    signal: any,
    cm: ContactMatch,
    playbookId: string | null,
    status = 'pending-review',
  ) {
    const existing = await this.db.signalMatch.findFirst({
      where: { signalId: signal.id, contactId: cm.contactId },
    });
    if (existing) return existing;

    return this.db.signalMatch.create({
      data: {
        signalId: signal.id,
        contactId: cm.contactId,
        confidence: cm.confidence,
        matchReason: cm.reason,
        companyDomain: signal.companyDomain,
        status,
        ...(playbookId ? { playbookId } : {}),
      },
    });
  }

  private hash(raw: RawSignal): string {
    const canonical = [
      (raw.companyDomain || raw.companyName || '').toLowerCase(),
      raw.suggestedType || '',
      (raw.dedupKey || raw.url || raw.title || '').toLowerCase().trim(),
    ].join('|');
    return createHash('sha256').update(canonical).digest('hex');
  }
}
