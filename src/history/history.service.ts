import { BadRequestException, Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';

// Query values arrive as strings (or arrays when a key repeats). An unparsable
// date used to reach MongoDB as Invalid Date and fail the request with 500.
function parseDateFilter(value: unknown, name: string) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${name} must be a valid date.`);
  }
  return date;
}

function dateRange(startDate?: string, endDate?: string) {
  if (!startDate && !endDate) return undefined;
  return {
    ...(startDate ? { gte: parseDateFilter(startDate, 'startDate') } : {}),
    ...(endDate ? { lte: parseDateFilter(endDate, 'endDate') } : {}),
  };
}

@Injectable()
export class HistoryService {
  constructor(private db: MongoService) {}

  async getEmailHistory(filters: {
    startDate?: string;
    endDate?: string;
    campaignId?: string;
    status?: string;
  }) {
    const where: any = {};

    if (filters.campaignId) {
      where.campaignId = String(filters.campaignId);
    }

    if (filters.status) {
      where.deliveryStatus = String(filters.status);
    }

    const range = dateRange(filters.startDate, filters.endDate);
    if (range) where.sentTime = range;

    return this.db.emailCampaignContact.findMany({
      where,
      include: {
        contact: true,
        campaign: { select: { name: true } },
      },
      orderBy: { sentTime: 'desc' },
    });
  }

  async getCallHistory(filters: {
    startDate?: string;
    endDate?: string;
    campaignId?: string;
    outcome?: string;
  }) {
    const where: any = {};

    if (filters.campaignId) {
      where.campaignId = String(filters.campaignId);
    }

    if (filters.outcome) {
      where.outcome = String(filters.outcome);
    }

    const range = dateRange(filters.startDate, filters.endDate);
    if (range) where.timestamp = range;

    return this.db.callHistory.findMany({
      where,
      include: {
        contact: true,
        campaign: { select: { name: true } },
      },
      orderBy: { timestamp: 'desc' },
    });
  }
}
