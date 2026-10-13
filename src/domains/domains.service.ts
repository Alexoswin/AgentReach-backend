import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';
import { MongoService } from '../mongo.service';
import { CreateDomainDto, UpdateDomainDto } from './dto/domain.dto';

const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function normalizeDomain(input: string) {
  const value = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .replace(/\.$/, '');
  if (!DOMAIN_PATTERN.test(value)) {
    throw new BadRequestException(
      'Enter a valid domain such as example.com or mail.example.com.',
    );
  }
  return value;
}

@Injectable()
export class DomainsService {
  constructor(private readonly db: MongoService) {}

  async list(userId: string) {
    const domains = await this.db.emailDomain.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return domains.map((domain: any) => this.toResponse(domain));
  }

  async create(userId: string, dto: CreateDomainDto) {
    const domain = normalizeDomain(dto.domain);
    const defaultSenderEmail = this.validateSender(
      dto.defaultSenderEmail,
      domain,
    );
    const existing = await this.db.emailDomain.findFirst({
      where: { ownerId: userId, domain },
    });
    if (existing) {
      throw new BadRequestException('This domain has already been added.');
    }

    const hasDomain =
      (await this.db.emailDomain.count({ where: { ownerId: userId } })) > 0;
    const created = await this.db.emailDomain.create({
      data: {
        ownerId: userId,
        domain,
        verificationToken: randomBytes(24).toString('hex'),
        defaultSenderEmail,
        status: 'PENDING',
        isDefault: !hasDomain,
        lastError: '',
      },
    });

    if (!hasDomain && defaultSenderEmail) {
      await this.saveSelectedSender(userId, created);
    }
    return this.toResponse(created);
  }

  async update(userId: string, id: string, dto: UpdateDomainDto) {
    const current = await this.findOwned(userId, id);
    const defaultSenderEmail = this.validateSender(
      dto.defaultSenderEmail,
      current.domain,
    );
    const updated = await this.db.emailDomain.update({
      where: { id, ownerId: userId },
      data: { defaultSenderEmail },
    });
    if (updated?.isDefault) await this.saveSelectedSender(userId, updated);
    return this.toResponse(updated);
  }

  async verify(userId: string, id: string) {
    const domain = await this.findOwned(userId, id);
    const name = `_reachconvert-verification.${domain.domain}`;
    let verified = false;
    let lastError = '';

    try {
      const records = await dns.resolveTxt(name);
      verified = records
        .flat()
        .some((value) => value === domain.verificationToken);
      if (!verified) lastError = `TXT record ${name} was not found.`;
    } catch (error: any) {
      lastError =
        error?.code === 'ENOTFOUND' || error?.code === 'ENODATA'
          ? `TXT record ${name} was not found.`
          : `DNS lookup failed: ${error?.message || 'unknown error'}`;
    }

    const updated = await this.db.emailDomain.update({
      where: { id, ownerId: userId },
      data: {
        status: verified ? 'VERIFIED' : 'PENDING',
        verifiedAt: verified ? new Date() : null,
        lastCheckedAt: new Date(),
        lastError,
      },
    });

    return {
      ...this.toResponse(updated),
      verified,
      message: verified
        ? 'Domain verified successfully.'
        : lastError || 'Add the DNS record and try again.',
    };
  }

  async setDefault(userId: string, id: string) {
    const domain = await this.findOwned(userId, id);
    if (domain.status !== 'VERIFIED') {
      throw new BadRequestException(
        'Verify this domain before using it as the default sender.',
      );
    }
    if (!domain.defaultSenderEmail) {
      throw new BadRequestException(
        'Add a sender email address for this domain before making it default.',
      );
    }

    await this.db.emailDomain.updateMany({
      where: { ownerId: userId },
      data: { isDefault: false },
    });
    const updated = await this.db.emailDomain.update({
      where: { id, ownerId: userId },
      data: { isDefault: true },
    });
    await this.saveSelectedSender(userId, updated);
    return this.toResponse(updated);
  }

  async remove(userId: string, id: string) {
    const domain = await this.findOwned(userId, id);
    await this.db.emailDomain.delete({ where: { id, ownerId: userId } });

    if (domain.isDefault) {
      const replacement = await this.db.emailDomain.findFirst({
        where: { ownerId: userId, status: 'VERIFIED' },
        orderBy: { createdAt: 'asc' },
      });
      if (replacement) {
        await this.db.emailDomain.update({
          where: { id: replacement.id, ownerId: userId },
          data: { isDefault: true },
        });
        await this.saveSelectedSender(userId, replacement);
      } else {
        await this.db.systemSettings.update({
          where: { id: userId },
          data: { sendingFromEmail: '' },
        });
      }
    }
    return { success: true };
  }

  private async findOwned(userId: string, id: string) {
    const domain = await this.db.emailDomain.findUnique({
      where: { id, ownerId: userId },
    });
    if (!domain) throw new NotFoundException('Domain not found.');
    return domain;
  }

  private validateSender(value: string | undefined, domain: string) {
    if (!value) return undefined;
    const sender = value.trim().toLowerCase();
    if (!sender.endsWith(`@${domain}`)) {
      throw new BadRequestException(
        `Sender address must use the verified domain ${domain}.`,
      );
    }
    return sender;
  }

  private async saveSelectedSender(userId: string, domain: any) {
    await this.db.systemSettings.upsert({
      where: { id: userId },
      update: {
        sendingDomainId: domain.id,
        sendingFromEmail: domain.defaultSenderEmail || '',
        replyTrackingDomain: `reply.${domain.domain}`,
      },
      create: {
        id: userId,
        sendingDomainId: domain.id,
        sendingFromEmail: domain.defaultSenderEmail || '',
        replyTrackingDomain: `reply.${domain.domain}`,
      },
    });
  }

  private toResponse(domain: any) {
    const inboundMx =
      process.env.MAIL_INBOUND_MX_HOSTNAME?.trim().replace(/\.$/, '') ||
      'inbound.mail.example.com';
    return {
      id: domain.id,
      domain: domain.domain,
      status: domain.status,
      defaultSenderEmail: domain.defaultSenderEmail || '',
      isDefault: Boolean(domain.isDefault),
      verifiedAt: domain.verifiedAt || null,
      lastCheckedAt: domain.lastCheckedAt || null,
      lastError: domain.lastError || '',
      records: [
        {
          type: 'TXT',
          name: `_reachconvert-verification.${domain.domain}`,
          value: domain.verificationToken,
          purpose: 'Domain ownership verification',
        },
        {
          type: 'MX',
          name: `reply.${domain.domain}`,
          value: `10 ${inboundMx}`,
          purpose: 'Route campaign replies to ReachConvert',
        },
      ],
    };
  }
}
