import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  GetIdentityVerificationAttributesCommand,
  ListIdentitiesCommand,
} from '@aws-sdk/client-ses';
import { isEmail } from 'class-validator';
import { hasSesCredentials, sesClientFor } from './ses';

const CACHE_MS = 5 * 60 * 1000;

export type SenderOptions = {
  defaultFrom: string | null;
  fromName: string;
  signature: string;
  addresses: string[];
  domains: string[];
};

/**
 * The From addresses a user may send as: their Sender Email plus every
 * verified SES identity. Any address at a verified domain (or a subdomain of
 * one) is allowed too.
 */
@Injectable()
export class MailSendersService {
  private readonly logger = new Logger(MailSendersService.name);
  private readonly cache = new Map<
    string,
    { at: number; addresses: string[]; domains: string[] }
  >();

  async options(settings: any): Promise<SenderOptions> {
    const defaultFrom = settings?.awsSenderEmail?.trim().toLowerCase() || null;
    const verified = await this.verifiedIdentities(settings);
    const addresses = [...new Set([defaultFrom, ...verified.addresses])].filter(
      (address): address is string => Boolean(address),
    );
    return {
      defaultFrom,
      fromName: settings?.mailFromName || '',
      signature: settings?.mailSignature || '',
      addresses,
      domains: verified.domains,
    };
  }

  async assertAllowedFrom(settings: any, email: string) {
    const address = (email || '').trim().toLowerCase();
    if (!isEmail(address)) {
      throw new BadRequestException('Choose a valid From address.');
    }
    const options = await this.options(settings);
    if (isAllowedFrom(address, options)) return address;
    throw new BadRequestException(
      `${address} is not verified in your AWS SES account. Send from your Sender Email or another verified address.`,
    );
  }

  private async verifiedIdentities(settings: any) {
    if (!hasSesCredentials(settings)) return { addresses: [], domains: [] };
    const key = `${settings.awsAccessKeyId}:${settings.awsRegion || 'us-east-1'}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;

    try {
      const client = sesClientFor(settings);
      const identities: string[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(
          new ListIdentitiesCommand({ MaxItems: 1000, NextToken: nextToken }),
        );
        identities.push(...(page.Identities || []));
        nextToken = page.NextToken;
      } while (nextToken && identities.length < 5000);

      const verified: string[] = [];
      for (let i = 0; i < identities.length; i += 100) {
        const result = await client.send(
          new GetIdentityVerificationAttributesCommand({
            Identities: identities.slice(i, i + 100),
          }),
        );
        for (const [identity, attributes] of Object.entries(
          result.VerificationAttributes || {},
        )) {
          if (attributes?.VerificationStatus === 'Success') {
            verified.push(identity.toLowerCase());
          }
        }
      }
      const entry = {
        at: Date.now(),
        addresses: verified.filter((identity) => identity.includes('@')).sort(),
        domains: verified.filter((identity) => !identity.includes('@')).sort(),
      };
      this.cache.set(key, entry);
      return entry;
    } catch (error) {
      this.logger.warn(
        `Could not list SES identities: ${(error as Error).message}`,
      );
      return { addresses: [], domains: [] };
    }
  }
}

export function isAllowedFrom(
  address: string,
  options: Pick<SenderOptions, 'defaultFrom' | 'addresses' | 'domains'>,
) {
  if (address === options.defaultFrom || options.addresses.includes(address)) {
    return true;
  }
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return options.domains.some(
    (verified) => domain === verified || domain.endsWith(`.${verified}`),
  );
}
