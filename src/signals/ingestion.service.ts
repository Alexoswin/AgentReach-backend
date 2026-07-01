import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { MongoService } from '../mongo.service';
import { SignalClassifierService } from './signal-classifier.service';
import { MatchingService } from './matching.service';
import { PlaybooksService } from './playbooks.service';
import { TriggerService } from './trigger.service';
import { RawSignal } from './signal.types';

const DEDUP_WINDOW_DAYS = 14;

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
   * Full pipeline for one raw signal: classify → dedup → persist → match →
   * evaluate playbooks (auto-trigger or queue for review).
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
          confidence: classification.confidence,
          entities: classification.entities,
        },
        hash,
        raw: raw.raw || {},
      },
    });

    await this.matchAndEvaluate(signal);
    return signal.id;
  }

  /** Match a persisted signal to contacts and run playbooks over each match. */
  private async matchAndEvaluate(signal: any): Promise<void> {
    // 'news-other' / low-value noise is stored but never matched/triggered.
    if (signal.type === 'news-other') return;

    const contactMatches = await this.matching.matchSignalToContacts(signal);

    for (const cm of contactMatches) {
      const contact = await this.db.contact.findUnique({
        where: { id: cm.contactId },
      });
      if (!contact) continue;

      const playbooks = await this.playbooks.findMatchingPlaybooks(
        signal.type,
        contact,
      );

      // No playbook: still record the match so it surfaces in the feed.
      if (playbooks.length === 0) {
        await this.upsertMatch(signal.id, cm.contactId, cm.confidence, null);
        continue;
      }

      for (const playbook of playbooks) {
        const shouldAutoFire =
          playbook.mode === 'auto' && cm.confidence === 'high';

        const match = await this.upsertMatch(
          signal.id,
          cm.contactId,
          cm.confidence,
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

  private async upsertMatch(
    signalId: string,
    contactId: string,
    confidence: string,
    playbookId: string | null,
    status = 'pending-review',
  ) {
    const existing = await this.db.signalMatch.findFirst({
      where: { signalId, contactId },
    });
    if (existing) return existing;

    return this.db.signalMatch.create({
      data: {
        signalId,
        contactId,
        confidence,
        status,
        ...(playbookId ? { playbookId } : {}),
      },
    });
  }

  private hash(raw: RawSignal): string {
    const canonical = [
      (raw.companyDomain || raw.companyName || '').toLowerCase(),
      raw.suggestedType || '',
      (raw.url || raw.title || '').toLowerCase().trim(),
    ].join('|');
    return createHash('sha256').update(canonical).digest('hex');
  }
}
