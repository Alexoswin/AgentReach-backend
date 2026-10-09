import { Injectable, BadRequestException } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { ImportContactsDto } from './dto/import-contacts.dto';
import { CreateContactDirectoryDto } from './dto/create-contact-directory.dto';
import { UpdateContactDirectoryDto } from './dto/update-contact-directory.dto';
import { parse } from 'csv-parse';
import * as XLSX from 'xlsx';
import { WatchService } from '../signals/watch.service';
import { ListContactsQueryDto } from './dto/list-contacts.dto';
import {
  buildPage,
  containsRegex,
  isPaginated,
  resolvePage,
} from '../common/pagination';

@Injectable()
export class ContactsService {
  constructor(
    private db: MongoService,
    private readonly watches: WatchService,
  ) {}

  async findAll(userId: string, query?: ListContactsQueryDto) {
    const where: Record<string, unknown> = { ownerId: userId };

    if (query?.directoryId === 'uncategorized') {
      where.directoryId = null;
    } else if (query?.directoryId && query.directoryId !== 'all') {
      where.directoryId = query.directoryId;
    }

    const term = query?.search?.trim();
    if (term) {
      const match = containsRegex(term);
      where.$or = [
        { firstName: match },
        { lastName: match },
        { email: match },
        { company: match },
        { jobTitle: match },
      ];
    }

    // `_id` breaks ties so rows never repeat or vanish between pages when many
    // contacts share a createdAt (bulk imports do).
    const orderBy = { createdAt: 'desc', id: 'desc' } as const;

    if (!isPaginated(query)) {
      return this.db.contact.findMany({ where, orderBy });
    }

    const { page, limit, skip } = resolvePage(query);
    const [items, total] = await Promise.all([
      this.db.contact.findMany({ where, orderBy, skip, take: limit }),
      this.db.contact.count({ where }),
    ]);
    return buildPage(items, total, page, limit);
  }

  /** Totals for the directory sidebar, without loading every contact. */
  async summary(userId: string) {
    const [total, unassigned] = await Promise.all([
      this.db.contact.count({ where: { ownerId: userId } }),
      this.db.contact.count({ where: { ownerId: userId, directoryId: null } }),
    ]);
    return { total, unassigned };
  }

  async findDirectories(userId: string) {
    const directories = await this.db.contactDirectory.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
    });
    const contacts = await this.db.contact.findMany({
      where: { ownerId: userId },
      select: { directoryId: true },
    });
    const counts = contacts.reduce(
      (acc: Record<string, number>, contact: any) => {
        if (contact.directoryId) {
          acc[contact.directoryId] = (acc[contact.directoryId] || 0) + 1;
        }
        return acc;
      },
      {},
    );

    return directories.map((directory: any) => ({
      ...directory,
      contactCount: counts[directory.id] || 0,
    }));
  }

  async createDirectory(dto: CreateContactDirectoryDto, userId: string) {
    const name = dto.name.trim();
    if (!name) {
      throw new BadRequestException('Directory name is required');
    }

    const existing = await this.db.contactDirectory.findFirst({
      where: { name, ownerId: userId },
    });
    if (existing) {
      throw new BadRequestException(
        'A directory with this name already exists',
      );
    }

    return this.db.contactDirectory.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        ownerId: userId,
      },
    });
  }

  async updateDirectory(
    id: string,
    dto: UpdateContactDirectoryDto,
    userId: string,
  ) {
    await this.findDirectory(id, userId);
    const data: Record<string, any> = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Directory name is required');
      }

      const existing = await this.db.contactDirectory.findFirst({
        where: { name, ownerId: userId },
      });
      if (existing && existing.id !== id) {
        throw new BadRequestException(
          'A directory with this name already exists',
        );
      }
      data.name = name;
    }

    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }

    return this.db.contactDirectory.update({
      where: { id, ownerId: userId },
      data,
    });
  }

  async removeDirectory(id: string, userId: string) {
    await this.findDirectory(id, userId);
    await this.db.contact.updateMany({
      where: { directoryId: id, ownerId: userId },
      data: { directoryId: null },
    });
    return this.db.contactDirectory.delete({
      where: { id, ownerId: userId },
    });
  }

  async findOne(id: string, userId: string) {
    const contact = await this.db.contact.findUnique({
      where: { id, ownerId: userId },
    });
    if (!contact) {
      throw new BadRequestException('Contact not found');
    }
    return contact;
  }

  async create(dto: CreateContactDto, userId: string) {
    const email = dto.email.trim().toLowerCase();
    const existing = await this.db.contact.findUnique({
      where: { email, ownerId: userId },
    });
    if (existing) {
      throw new BadRequestException('A contact with this email already exists');
    }

    await this.ensureDirectoryExists(dto.directoryId, userId);
    const { customFields, ...rest } = dto;
    const contact = await this.db.contact.create({
      data: {
        ...rest,
        email,
        ownerId: userId,
        phoneNumber: this.normalizePhoneNumber(rest.phoneNumber),
        directoryId: rest.directoryId || null,
        customFields: customFields ? JSON.stringify(customFields) : null,
      },
    });

    // Best-effort: start watching this contact's company for buying signals.
    void this.watches
      .ensureWatchesForEmails([{ email, company: rest.company }], userId)
      .catch(() => undefined);

    return contact;
  }

  async update(id: string, dto: Partial<CreateContactDto>, userId: string) {
    await this.findOne(id, userId); // Check existence
    if (dto.email) {
      const existing = await this.db.contact.findUnique({
        where: { email: dto.email.trim().toLowerCase(), ownerId: userId },
      });
      if (existing && existing.id !== id) {
        throw new BadRequestException(
          'A contact with this email already exists',
        );
      }
    }

    await this.ensureDirectoryExists(dto.directoryId, userId);
    const { customFields, ...rest } = dto;
    // Partial<> has no runtime type, so this body is not whitelisted; it must
    // not be able to hand the contact to another owner.
    delete (rest as Record<string, unknown>).ownerId;
    const data = {
      ...rest,
      ...(rest.email ? { email: rest.email.trim().toLowerCase() } : {}),
      ...(rest.phoneNumber !== undefined
        ? { phoneNumber: this.normalizePhoneNumber(rest.phoneNumber) }
        : {}),
      ...(customFields !== undefined
        ? { customFields: customFields ? JSON.stringify(customFields) : null }
        : {}),
    };

    return this.db.contact.update({
      where: { id, ownerId: userId },
      data,
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    return this.db.contact.delete({
      where: { id, ownerId: userId },
    });
  }

  async parseFile(file: Express.Multer.File): Promise<{
    headers: string[];
    previewRows: any[];
    totalRows: number;
    allRows: any[];
  }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    let result: { headers: string[]; rows: any[] };

    if (file.originalname.endsWith('.csv')) {
      result = await this.parseCsv(file.buffer);
    } else if (
      file.originalname.endsWith('.xlsx') ||
      file.originalname.endsWith('.xls')
    ) {
      result = this.parseXlsx(file.buffer);
    } else {
      throw new BadRequestException(
        'Unsupported file format. Please upload CSV or XLSX.',
      );
    }

    return {
      headers: result.headers,
      previewRows: result.rows.slice(0, 5),
      totalRows: result.rows.length,
      allRows: result.rows,
    };
  }

  private parseCsv(
    buffer: Buffer,
  ): Promise<{ headers: string[]; rows: any[] }> {
    return new Promise((resolve, reject) => {
      parse(
        buffer,
        {
          // A "__proto__" (or similar) header must stay an ordinary column
          // name instead of reaching an object's prototype.
          columns: (header: string[]) =>
            header.map((name) =>
              ['__proto__', 'constructor', 'prototype'].includes(name)
                ? `_${name}`
                : name,
            ),
          skip_empty_lines: true,
          trim: true,
        },
        (err, records: any) => {
          if (err)
            return reject(
              new BadRequestException('Error parsing CSV file: ' + err.message),
            );
          if (!records || records.length === 0) {
            return resolve({ headers: [], rows: [] });
          }
          const headers = Object.keys(records[0]);
          resolve({ headers, rows: records });
        },
      );
    });
  }

  private parseXlsx(buffer: Buffer): { headers: string[]; rows: any[] } {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        throw new Error('Workbook contains no sheets');
      }
      const sheet = workbook.Sheets[sheetName];
      const records: Record<string, unknown>[] = XLSX.utils.sheet_to_json(
        sheet,
        {
          defval: '',
        },
      );
      if (records.length === 0) {
        return { headers: [], rows: [] };
      }
      const firstRecord = records[0];
      const headers = Object.keys(firstRecord);
      return { headers, rows: records };
    } catch (err: any) {
      throw new BadRequestException('Error parsing XLSX file: ' + err.message);
    }
  }

  async importContacts(dto: ImportContactsDto, userId: string) {
    const { rows, mapping, duplicateStrategy = 'SKIP', directoryId } = dto;
    await this.ensureDirectoryExists(directoryId, userId);
    let importedCount = 0;
    let skippedCount = 0;
    let updatedCount = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      try {
        // Map row keys using schema
        const firstName = row[mapping['firstName']]?.toString().trim();
        const lastName = row[mapping['lastName']]?.toString().trim();
        const email = row[mapping['email']]?.toString().trim().toLowerCase();

        if (!email) {
          errors.push(`Row ${i + 1}: Missing email`);
          skippedCount++;
          continue;
        }

        if (!firstName) {
          errors.push(`Row ${i + 1}: Missing first name`);
          skippedCount++;
          continue;
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          errors.push(`Row ${i + 1}: Invalid email format (${email})`);
          skippedCount++;
          continue;
        }

        const company = mapping['company']
          ? row[mapping['company']]?.toString().trim()
          : null;
        const jobTitle = mapping['jobTitle']
          ? row[mapping['jobTitle']]?.toString().trim()
          : null;
        const linkedinUrl = mapping['linkedinUrl']
          ? row[mapping['linkedinUrl']]?.toString().trim()
          : null;
        const phoneNumber = this.normalizePhoneNumber(
          mapping['phoneNumber']
            ? row[mapping['phoneNumber']]?.toString().trim()
            : null,
        );
        const notes = mapping['notes']
          ? row[mapping['notes']]?.toString().trim()
          : null;

        // Custom fields map all non-standard fields that have mapping configurations
        const customFields: Record<string, any> = {};
        for (const [fieldKey, fileCol] of Object.entries(mapping)) {
          const standardFields = [
            'firstName',
            'lastName',
            'email',
            'company',
            'jobTitle',
            'linkedinUrl',
            'phoneNumber',
            'notes',
          ];
          if (!standardFields.includes(fieldKey) && fileCol) {
            customFields[fieldKey] = row[fileCol];
          }
        }

        const existing = await this.db.contact.findUnique({
          where: { email, ownerId: userId },
        });

        const contactData = {
          firstName: firstName || '',
          lastName: lastName || '',
          company,
          jobTitle,
          linkedinUrl,
          phoneNumber,
          notes,
          directoryId: directoryId || null,
          customFields:
            Object.keys(customFields).length > 0
              ? JSON.stringify(customFields)
              : null,
        };

        if (existing) {
          if (duplicateStrategy === 'SKIP') {
            skippedCount++;
            continue;
          } else {
            // OVERWRITE
            await this.db.contact.update({
              where: { id: existing.id, ownerId: userId },
              data: contactData,
            });
            updatedCount++;
          }
        } else {
          await this.db.contact.create({
            data: {
              email,
              ...contactData,
              ownerId: userId,
            },
          });
          importedCount++;
        }
      } catch (err: any) {
        errors.push(`Row ${i + 1}: Database error - ${err.message}`);
        skippedCount++;
      }
    }

    // Best-effort: auto-create company watches for imported domains.
    const watchEntries = rows
      .map((row) => ({
        email: row[mapping['email']]?.toString().trim().toLowerCase(),
        company: row[mapping['company']]?.toString().trim(),
      }))
      .filter((e) => e.email);
    void this.watches
      .ensureWatchesForEmails(watchEntries, userId)
      .catch(() => undefined);

    return {
      success: true,
      importedCount,
      skippedCount,
      updatedCount,
      errors,
    };
  }

  private async findDirectory(id: string, userId: string) {
    const directory = await this.db.contactDirectory.findUnique({
      where: { id, ownerId: userId },
    });
    if (!directory) {
      throw new BadRequestException('Directory not found');
    }
    return directory;
  }

  private async ensureDirectoryExists(
    directoryId: string | null | undefined,
    userId: string,
  ) {
    if (!directoryId) return;
    await this.findDirectory(directoryId, userId);
  }

  private normalizePhoneNumber(phoneNumber?: string | null) {
    const raw = phoneNumber?.trim();
    if (!raw) return null;

    const hasInternationalPrefix = raw.startsWith('+');
    const digits = raw.replace(/\D/g, '');
    if (!digits) return null;

    if (hasInternationalPrefix) return `+${digits}`;
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) {
      return `+91${digits.slice(1)}`;
    }

    return `+${digits}`;
  }
}
