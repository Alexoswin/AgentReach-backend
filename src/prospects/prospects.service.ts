import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { resolveGeminiTextModel } from '../config/gemini-text';
import { ContactsService } from '../contacts/contacts.service';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { WatchService } from '../signals/watch.service';
import {
  AddProspectsToContactsDto,
  BuildProfileDto,
  CreateProspectSearchDto,
  UpdateProspectDto,
} from './dto/prospect.dto';
import { createGeminiJson, GeminiJson } from './gemini-json';
import { buildProfile, normalizeProfile } from './icp';
import {
  DEFAULT_LOOKUP_PEOPLE_PER_COMPANY,
  DEFAULT_MAX_COMPANIES,
  DEFAULT_PEOPLE_PER_COMPANY,
  MAX_LOOKUP_COMPANIES,
  MAX_SEARCHES_PER_DAY,
  RUN_TIME_BUDGET_MS,
  STALE_RUN_MS,
} from './prospect.constants';
import { runSearch } from './search-runner';
import { normalizeDomain, SiteReader } from './site-reader';
import { WebsiteSource } from './sources/website.source';

const COST_PER_COMPANY_USD = { min: 0.008, max: 0.02 };
const TERMINAL = new Set(['completed', 'cancelled']);

@Injectable()
export class ProspectsService {
  private readonly running = new Set<string>();

  constructor(
    private readonly db: MongoService,
    private readonly settings: SettingsService,
    private readonly contacts: ContactsService,
    private readonly watches: WatchService,
  ) {}

  async buildProfile(userId: string, dto: BuildProfileDto) {
    const { generate } = await this.gemini(userId);
    const exampleDomains = (dto.exampleDomains || [])
      .map((item) => normalizeDomain(item))
      .filter(Boolean);
    const profile = await buildProfile(
      generate,
      dto.description.trim(),
      exampleDomains,
    );
    const companies = dto.maxCompanies || DEFAULT_MAX_COMPANIES;
    return {
      profile,
      estimate: {
        companies,
        costUsd: {
          min: Number((companies * COST_PER_COMPANY_USD.min).toFixed(2)),
          max: Number((companies * COST_PER_COMPANY_USD.max).toFixed(2)),
        },
        source: 'website',
      },
    };
  }

  async createSearch(userId: string, dto: CreateProspectSearchDto) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await this.db.prospectSearch.count({
      where: { ownerId: userId, createdAt: { gte: since } },
    });
    if (recent >= MAX_SEARCHES_PER_DAY) {
      throw new BadRequestException(
        `Daily limit reached: ${MAX_SEARCHES_PER_DAY} searches per 24 hours.`,
      );
    }
    const base = {
      ownerId: userId,
      status: 'ready',
      stage: 'find',
      counts: {},
    };

    if (dto.mode === 'companies') {
      const targets = [
        ...new Set(
          (dto.companies || []).map((item) => item.trim()).filter(Boolean),
        ),
      ].slice(0, MAX_LOOKUP_COMPANIES);
      if (!targets.length) {
        throw new BadRequestException('Add at least one company.');
      }
      return this.db.prospectSearch.create({
        data: {
          ...base,
          mode: 'companies',
          targets,
          description: `Contacts at ${targets.join(', ')}`.slice(0, 1000),
          profile: normalizeProfile({ jobTitles: dto.profile?.jobTitles }),
          maxCompanies: targets.length,
          peoplePerCompany:
            dto.peoplePerCompany || DEFAULT_LOOKUP_PEOPLE_PER_COMPANY,
        },
      });
    }

    const description = dto.description?.trim() || '';
    if (description.length < 10 || !dto.profile) {
      throw new BadRequestException(
        'Describe your ideal customer in at least 10 characters.',
      );
    }
    return this.db.prospectSearch.create({
      data: {
        ...base,
        mode: 'icp',
        targets: [],
        description,
        profile: normalizeProfile(dto.profile),
        maxCompanies: dto.maxCompanies || DEFAULT_MAX_COMPANIES,
        peoplePerCompany: dto.peoplePerCompany || DEFAULT_PEOPLE_PER_COMPANY,
      },
    });
  }

  listSearches(userId: string) {
    return this.db.prospectSearch.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async getSearch(userId: string, id: string) {
    const search = await this.db.prospectSearch.findUnique({
      where: { id, ownerId: userId },
    });
    if (!search) throw new NotFoundException('Search not found');
    return search;
  }

  async listCompanies(userId: string, id: string) {
    await this.getSearch(userId, id);
    return this.db.prospectCompany.findMany({
      where: { searchId: id, ownerId: userId },
      orderBy: { score: 'desc' },
    });
  }

  async listPeople(userId: string, id: string, status?: string) {
    await this.getSearch(userId, id);
    return this.db.prospect.findMany({
      where: {
        searchId: id,
        ownerId: userId,
        ...(status ? { status } : {}),
      },
      orderBy: { score: 'desc' },
    });
  }

  async run(userId: string, id: string, signal: AbortSignal) {
    const search = await this.getSearch(userId, id);
    if (TERMINAL.has(search.status)) return this.summary(search);
    if (this.running.has(id)) {
      throw new ConflictException('This search is already running.');
    }

    const active = await this.db.prospectSearch.findFirst({
      where: { ownerId: userId, status: 'running' },
    });
    const activeHeartbeat = active?.heartbeatAt
      ? new Date(active.heartbeatAt).getTime()
      : 0;
    if (
      active &&
      active.id !== id &&
      Date.now() - activeHeartbeat < STALE_RUN_MS
    ) {
      throw new ConflictException('Another search is already running.');
    }

    const { generate } = await this.gemini(userId);
    this.running.add(id);
    await this.db.prospectSearch.update({
      where: { id },
      data: { status: 'running', heartbeatAt: new Date(), error: '' },
    });

    try {
      const outcome = await runSearch(
        { ...search, status: 'running' },
        {
          db: this.db,
          generate,
          reader: new SiteReader(),
          createSource: (counted) => new WebsiteSource(counted),
        },
        { signal, deadline: Date.now() + RUN_TIME_BUDGET_MS },
      );
      const updated = await this.db.prospectSearch.update({
        where: { id },
        data: {
          status: outcome.status,
          stage: outcome.stage,
          note: outcome.note || '',
          error: outcome.error || '',
        },
      });
      return this.summary(updated);
    } finally {
      this.running.delete(id);
    }
  }

  async cancel(userId: string, id: string) {
    const search = await this.getSearch(userId, id);
    if (TERMINAL.has(search.status)) return this.summary(search);
    const updated = await this.db.prospectSearch.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    return this.summary(updated);
  }

  async removeSearch(userId: string, id: string) {
    await this.getSearch(userId, id);
    await this.db.prospect.deleteMany({
      where: { searchId: id, ownerId: userId },
    });
    await this.db.prospectCompany.deleteMany({
      where: { searchId: id, ownerId: userId },
    });
    await this.db.prospectSearch.delete({ where: { id, ownerId: userId } });
    return { success: true };
  }

  async updateProspect(userId: string, id: string, dto: UpdateProspectDto) {
    const prospect = await this.db.prospect.findUnique({
      where: { id, ownerId: userId },
    });
    if (!prospect) throw new NotFoundException('Prospect not found');
    if (prospect.status === 'added') {
      throw new BadRequestException('This person is already in your contacts.');
    }

    const data: Record<string, unknown> = {};
    if (dto.email) {
      const domain = dto.email.toLowerCase().split('@')[1];
      const companyDomain = String(prospect.domain);
      if (domain !== companyDomain && !domain.endsWith(`.${companyDomain}`)) {
        throw new BadRequestException(
          `Use a work email at ${companyDomain} for this person.`,
        );
      }
      data.email = dto.email.trim().toLowerCase();
      data.emailStatus = 'published';
      data.status = 'ready';
    }
    if (dto.action === 'dismissed') data.status = 'dismissed';
    if (dto.action === 'restore') {
      data.status = prospect.email || data.email ? 'ready' : 'needs_email';
    }
    return this.db.prospect.update({ where: { id }, data });
  }

  async addToContacts(userId: string, dto: AddProspectsToContactsDto) {
    const prospects = await this.db.prospect.findMany({
      where: { id: { in: dto.ids }, ownerId: userId },
    });
    const skipped: Array<{ id: string; reason: string }> = [];
    const eligible = [];
    for (const prospect of prospects) {
      if (prospect.status !== 'ready' || !prospect.email) {
        skipped.push({
          id: prospect.id,
          reason: prospect.email
            ? 'Already handled'
            : 'Needs a verified work email first',
        });
      } else {
        eligible.push(prospect);
      }
    }
    if (!eligible.length) {
      return { added: 0, updated: 0, duplicates: 0, skipped, errors: [] };
    }

    const emails = eligible.map((prospect) => String(prospect.email));
    const before = await this.db.contact.findMany({
      where: { ownerId: userId, email: { in: emails } },
      select: { email: true },
    });
    const existing = new Set(
      before.map((contact: any) => String(contact.email)),
    );

    const result = await this.contacts.importContacts(
      {
        rows: eligible.map((prospect) => ({
          firstName: prospect.firstName,
          lastName: prospect.lastName,
          email: prospect.email,
          company: prospect.companyName,
          jobTitle: prospect.jobTitle || '',
          phoneNumber: prospect.phone,
          linkedinUrl: prospect.linkedinUrl,
          notes: `Found by Prospect Finder${prospect.score > 0 ? ` (${prospect.score}% match)` : ''}. Source: ${prospect.sourceUrl || prospect.domain}`,
          prospectScore: String(prospect.score),
          prospectSource: prospect.sourceUrl || '',
        })),
        mapping: {
          firstName: 'firstName',
          lastName: 'lastName',
          email: 'email',
          company: 'company',
          jobTitle: 'jobTitle',
          phoneNumber: 'phoneNumber',
          linkedinUrl: 'linkedinUrl',
          notes: 'notes',
          prospectScore: 'prospectScore',
          prospectSource: 'prospectSource',
        },
        duplicateStrategy: dto.duplicateStrategy || 'SKIP',
        directoryId: dto.directoryId,
      },
      userId,
    );

    const contacts = await this.db.contact.findMany({
      where: { ownerId: userId, email: { in: emails } },
      select: { email: true },
    });
    const byEmail = new Map(
      contacts.map((contact: any) => [String(contact.email), contact.id]),
    );
    const overwrite = dto.duplicateStrategy === 'OVERWRITE';
    let duplicates = 0;
    for (const prospect of eligible) {
      const email = String(prospect.email);
      const contactId = byEmail.get(email);
      if (!contactId) continue;
      const isDuplicate = existing.has(email) && !overwrite;
      if (isDuplicate) duplicates++;
      await this.db.prospect.update({
        where: { id: prospect.id },
        data: {
          status: isDuplicate ? 'duplicate' : 'added',
          contactId,
          expireAt: null,
        },
      });
    }

    return {
      added: result.importedCount,
      updated: result.updatedCount,
      duplicates,
      skipped,
      errors: result.errors,
    };
  }

  async watchCompany(userId: string, companyId: string) {
    const company = await this.db.prospectCompany.findUnique({
      where: { id: companyId, ownerId: userId },
    });
    if (!company) throw new NotFoundException('Company not found');
    await this.watches.create(
      String(company.name),
      String(company.domain),
      userId,
    );
    return { success: true };
  }

  private summary(search: any) {
    return {
      id: search.id,
      status: search.status,
      stage: search.stage,
      counts: search.counts || {},
      note: search.note || '',
      error: search.error || '',
      done: TERMINAL.has(search.status) || search.status === 'failed',
    };
  }

  private async gemini(userId: string): Promise<{ generate: GeminiJson }> {
    const settings = await this.settings.getRawSettings(userId);
    const apiKey = settings?.geminiApiKey?.trim();
    if (!apiKey) {
      throw new BadRequestException(
        'Add your Gemini API key in Settings before using Prospect Finder.',
      );
    }
    const model = resolveGeminiTextModel(settings?.geminiTextModel);
    return { generate: createGeminiJson(apiKey, model) };
  }
}
