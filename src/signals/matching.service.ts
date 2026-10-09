import { Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { Confidence, MatchReason } from './signal.types';

export interface ContactMatch {
  contactId: string;
  confidence: Confidence;
  reason: MatchReason;
}

/**
 * Resolves a signal to the contacts it should reach, with a confidence tier:
 *  - domain match (contact email domain === signal domain) → high
 *  - normalized company-name match → medium
 *
 * Both paths query the contacts collection with a narrowing filter instead of
 * scanning every contact per signal.
 */
@Injectable()
export class MatchingService {
  constructor(private readonly db: MongoService) {}

  /** Only the owner's contacts are candidates. */
  async matchSignalToContacts(
    signal: {
      companyDomain?: string;
      companyName?: string;
    },
    ownerId: string,
  ): Promise<ContactMatch[]> {
    const domain = signal.companyDomain?.toLowerCase().trim();
    const nameKey = this.normalizeName(signal.companyName);

    const matches = new Map<string, ContactMatch>();

    if (domain) {
      const byDomain = await this.db.contact.findMany({
        where: {
          ownerId,
          email: { $regex: `@${escapeRegex(domain)}$`, $options: 'i' },
        },
      });
      for (const contact of byDomain) {
        matches.set(contact.id, {
          contactId: contact.id,
          confidence: 'high',
          reason: 'email-domain',
        });
      }
    }

    // Name matching narrows in the DB on the first significant token, then
    // confirms with the full normalized comparison in JS. A contact whose
    // stored company doesn't contain that token (e.g. "A.C.M.E" for "Acme")
    // is missed — acceptable for a medium-confidence fuzzy path.
    const nameToken = this.firstToken(signal.companyName);
    if (nameKey && nameToken.length >= 3) {
      const byName = await this.db.contact.findMany({
        where: {
          ownerId,
          company: { $regex: escapeRegex(nameToken), $options: 'i' },
        },
      });
      for (const contact of byName) {
        if (matches.has(contact.id)) continue;
        if (this.normalizeName(contact.company) === nameKey) {
          matches.set(contact.id, {
            contactId: contact.id,
            confidence: 'medium',
            reason: 'company-name',
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

  /** First alphanumeric word of the name after stripping suffix noise. */
  private firstToken(name?: string): string {
    if (!name) return '';
    return (
      name
        .toLowerCase()
        .replace(/\b(inc|llc|ltd|corp|co|the|company)\b/g, ' ')
        .match(/[a-z0-9]+/)?.[0] || ''
    );
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
