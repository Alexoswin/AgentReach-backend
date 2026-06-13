import { Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';

@Injectable()
export class HistoryService {
  constructor(private db: MongoService) {}

  async getEmailHistory(filters: { startDate?: string; endDate?: string; campaignId?: string; status?: string }) {
    const where: any = {};

    if (filters.campaignId) {
      where.campaignId = filters.campaignId;
    }

    if (filters.status) {
      where.deliveryStatus = filters.status;
    }

    if (filters.startDate || filters.endDate) {
      where.sentTime = {};
      if (filters.startDate) {
        where.sentTime.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.sentTime.lte = new Date(filters.endDate);
      }
    }

    return this.db.emailCampaignContact.findMany({
      where,
      include: {
        contact: true,
        campaign: { select: { name: true } },
      },
      orderBy: { sentTime: 'desc' },
    });
  }

  async getCallHistory(filters: { startDate?: string; endDate?: string; campaignId?: string; outcome?: string }) {
    const where: any = {};

    if (filters.campaignId) {
      where.campaignId = filters.campaignId;
    }

    if (filters.outcome) {
      where.outcome = filters.outcome;
    }

    if (filters.startDate || filters.endDate) {
      where.timestamp = {};
      if (filters.startDate) {
        where.timestamp.gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        where.timestamp.lte = new Date(filters.endDate);
      }
    }

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
