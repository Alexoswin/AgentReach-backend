import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CompanyWatchLike } from './signal.types';

// Public email domains we never want to create a company watch for.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'live.com',
  'msn.com',
]);

// Per owner.
const MAX_WATCHES = 500;

@Injectable()
export class WatchService {
  private readonly logger = new Logger(WatchService.name);

  constructor(private readonly db: MongoService) {}

  async findAll(userId: string): Promise<CompanyWatchLike[]> {
    return this.db.companyWatch.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Active watches of one owner, or of every owner for the cron poll. */
  async findActive(ownerId?: string): Promise<CompanyWatchLike[]> {
    return this.db.companyWatch.findMany({
      where: { status: 'active', ...(ownerId ? { ownerId } : {}) },
    });
  }

  async create(
    companyName: string,
    domain: string,
    userId: string,
    sources?: string[],
  ) {
    const normalizedDomain = domain.toLowerCase().trim();
    const existing = await this.db.companyWatch.findUnique({
      where: { domain: normalizedDomain, ownerId: userId },
    });
    if (existing) return existing;

    return this.db.companyWatch.create({
      data: {
        ownerId: userId,
        companyName: companyName?.trim() || normalizedDomain,
        domain: normalizedDomain,
        ...(sources ? { sourcesEnabled: sources } : {}),
        lastPolledAt: {},
        status: 'active',
      },
    });
  }

  async toggle(id: string, userId: string) {
    const watch = await this.db.companyWatch.findUnique({
      where: { id, ownerId: userId },
    });
    if (!watch) throw new BadRequestException('Watch not found');
    return this.db.companyWatch.update({
      where: { id, ownerId: userId },
      data: { status: watch.status === 'active' ? 'paused' : 'active' },
    });
  }

  async remove(id: string, userId: string) {
    const watch = await this.db.companyWatch.delete({
      where: { id, ownerId: userId },
    });
    if (!watch) throw new BadRequestException('Watch not found');
    return watch;
  }

  async markPolled(watchId: string, source: string) {
    const watch = await this.db.companyWatch.findUnique({
      where: { id: watchId },
    });
    if (!watch) return;
    const lastPolledAt = { ...(watch.lastPolledAt || {}) };
    lastPolledAt[source] = new Date().toISOString();
    await this.db.companyWatch.update({
      where: { id: watchId },
      data: { lastPolledAt },
    });
  }

  /**
   * Auto-create watches from a batch of contact email addresses.
   * Skips free-mail domains and respects the per-owner watch cap.
   */
  async ensureWatchesForEmails(
    entries: { email?: string; company?: string }[],
    userId: string,
  ): Promise<number> {
    let created = 0;
    const seen = new Set<string>();

    const currentCount = await this.db.companyWatch.count({
      where: { ownerId: userId },
    });
    let budget = Math.max(0, MAX_WATCHES - currentCount);

    for (const entry of entries) {
      if (budget <= 0) break;
      const domain = entry.email?.split('@')[1]?.toLowerCase().trim();
      if (!domain || seen.has(domain) || FREE_EMAIL_DOMAINS.has(domain)) {
        continue;
      }
      seen.add(domain);

      const existing = await this.db.companyWatch.findUnique({
        where: { domain, ownerId: userId },
      });
      if (existing) continue;

      try {
        await this.create(
          entry.company || this.nameFromDomain(domain),
          domain,
          userId,
        );
        created++;
        budget--;
      } catch (err) {
        this.logger.warn(
          `Could not create watch for ${domain}: ${(err as Error).message}`,
        );
      }
    }

    return created;
  }

  private nameFromDomain(domain: string): string {
    const core = domain.split('.')[0] || domain;
    return core.charAt(0).toUpperCase() + core.slice(1);
  }
}
