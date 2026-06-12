import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { ImportContactsDto } from './dto/import-contacts.dto';
import { parse } from 'csv-parse';
import * as XLSX from 'xlsx';

@Injectable()
export class ContactsService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.contact.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id },
    });
    if (!contact) {
      throw new BadRequestException('Contact not found');
    }
    return contact;
  }

  async create(dto: CreateContactDto) {
    const existing = await this.prisma.contact.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new BadRequestException('A contact with this email already exists');
    }

    const { customFields, ...rest } = dto;
    return this.prisma.contact.create({
      data: {
        ...rest,
        customFields: customFields ? JSON.stringify(customFields) : null,
      },
    });
  }

  async update(id: string, dto: Partial<CreateContactDto>) {
    await this.findOne(id); // Check existence
    if (dto.email) {
      const existing = await this.prisma.contact.findUnique({
        where: { email: dto.email },
      });
      if (existing && existing.id !== id) {
        throw new BadRequestException('A contact with this email already exists');
      }
    }

    const { customFields, ...rest } = dto;
    return this.prisma.contact.update({
      where: { id },
      data: {
        ...rest,
        ...(customFields !== undefined
          ? { customFields: customFields ? JSON.stringify(customFields) : null }
          : {}),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.contact.delete({
      where: { id },
    });
  }

  async parseFile(file: Express.Multer.File): Promise<{ headers: string[]; previewRows: any[]; totalRows: number; allRows: any[] }> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    let result: { headers: string[]; rows: any[] };

    if (file.originalname.endsWith('.csv')) {
      result = await this.parseCsv(file.buffer);
    } else if (file.originalname.endsWith('.xlsx') || file.originalname.endsWith('.xls')) {
      result = this.parseXlsx(file.buffer);
    } else {
      throw new BadRequestException('Unsupported file format. Please upload CSV or XLSX.');
    }

    return {
      headers: result.headers,
      previewRows: result.rows.slice(0, 5),
      totalRows: result.rows.length,
      allRows: result.rows,
    };
  }

  private parseCsv(buffer: Buffer): Promise<{ headers: string[]; rows: any[] }> {
    return new Promise((resolve, reject) => {
      parse(buffer, { columns: true, skip_empty_lines: true, trim: true }, (err, records: any) => {
        if (err) return reject(new BadRequestException('Error parsing CSV file: ' + err.message));
        if (!records || records.length === 0) {
          return resolve({ headers: [], rows: [] });
        }
        const headers = Object.keys(records[0]);
        resolve({ headers, rows: records });
      });
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
      const records = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as any[];
      if (records.length === 0) {
        return { headers: [], rows: [] };
      }
      const headers = Object.keys(records[0]);
      return { headers, rows: records };
    } catch (err: any) {
      throw new BadRequestException('Error parsing XLSX file: ' + err.message);
    }
  }

  async importContacts(dto: ImportContactsDto) {
    const { rows, mapping, duplicateStrategy = 'SKIP' } = dto;
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

        const company = mapping['company'] ? row[mapping['company']]?.toString().trim() : null;
        const jobTitle = mapping['jobTitle'] ? row[mapping['jobTitle']]?.toString().trim() : null;
        const linkedinUrl = mapping['linkedinUrl'] ? row[mapping['linkedinUrl']]?.toString().trim() : null;
        const phoneNumber = mapping['phoneNumber'] ? row[mapping['phoneNumber']]?.toString().trim() : null;
        const notes = mapping['notes'] ? row[mapping['notes']]?.toString().trim() : null;

        // Custom fields map all non-standard fields that have mapping configurations
        const customFields: Record<string, any> = {};
        for (const [fieldKey, fileCol] of Object.entries(mapping)) {
          const standardFields = ['firstName', 'lastName', 'email', 'company', 'jobTitle', 'linkedinUrl', 'phoneNumber', 'notes'];
          if (!standardFields.includes(fieldKey) && fileCol) {
            customFields[fieldKey] = row[fileCol];
          }
        }

        const existing = await this.prisma.contact.findUnique({
          where: { email },
        });

        const contactData = {
          firstName: firstName || '',
          lastName: lastName || '',
          company,
          jobTitle,
          linkedinUrl,
          phoneNumber,
          notes,
          customFields: Object.keys(customFields).length > 0 ? JSON.stringify(customFields) : null,
        };

        if (existing) {
          if (duplicateStrategy === 'SKIP') {
            skippedCount++;
            continue;
          } else {
            // OVERWRITE
            await this.prisma.contact.update({
              where: { id: existing.id },
              data: contactData,
            });
            updatedCount++;
          }
        } else {
          await this.prisma.contact.create({
            data: {
              email,
              ...contactData,
            },
          });
          importedCount++;
        }
      } catch (err: any) {
        errors.push(`Row ${i + 1}: Database error - ${err.message}`);
        skippedCount++;
      }
    }

    return {
      success: true,
      importedCount,
      skippedCount,
      updatedCount,
      errors,
    };
  }
}
