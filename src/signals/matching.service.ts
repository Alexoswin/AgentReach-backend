import { Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { Confidence } from './signal.types';

export interface ContactMatch {
  contactId: string;
  confidence: Confidence;
}

/**
 * Resolves a signal to the contacts it should reach, with a confidence tier:
 *  - domain match (contact email domain === signal domain) → high
 *  - normalized company-name match → medium
 */
@Injectable()
export class MatchingService {
  constructor(private readonly db: MongoService) {}

  async matchSignalToContacts(signal: {
    companyDomain?: string;
    companyName?: string;
  }): Promise<ContactMatch[]> {
    const contacts = await this.db.contact.findMany({});
    const domain = signal.companyDomain?.toLowerCase().trim();
    const nameKey = this.normalizeName(signal.companyName);

    const matches = new Map<string, ContactMatch>();

    for (const contact of contacts) {
      const contactDomain = contact.email?.split('@')[1]?.toLowerCase().trim();

      if (domain && contactDomain === domain) {
        matches.set(contact.id, { contactId: contact.id, confidence: 'high' });
        continue;
      }

      if (nameKey && this.normalizeName(contact.company) === nameKey) {
        if (!matches.has(contact.id)) {
          matches.set(contact.id, {
            contactId: contact.id,
            confidence: 'medium',
          });
        }
      }
    }

    return [...matches.values()];
  }

  private normalizeName(name?: string): string {
    if (!name) return '';
    return name
      .toLowerCase()
      .replace(/\b(inc|llc|ltd|corp|co|the|company)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }
}
