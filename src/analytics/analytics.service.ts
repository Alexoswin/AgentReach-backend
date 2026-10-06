import { Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';

@Injectable()
export class AnalyticsService {
  constructor(private db: MongoService) {}

  async getDashboardAnalytics() {
    // 1. Email Metrics
    const emailHistory = await this.db.emailCampaignContact.findMany({
      include: {
        campaign: {
          include: { template: true },
        },
        contact: true,
      },
    });

    const sentCount = emailHistory.filter((h) =>
      this.isSent(h.deliveryStatus),
    ).length;
    const failedCount = emailHistory.filter(
      (h) => h.deliveryStatus === 'FAILED',
    ).length;

    const openCount = emailHistory.filter((h) => h.openStatus).length;
    const replyCount = emailHistory.filter((h) => h.replyStatus).length;

    const openRate =
      sentCount > 0 ? Math.round((openCount / sentCount) * 100) : 0;
    const replyRate =
      sentCount > 0 ? Math.round((replyCount / sentCount) * 100) : 0;

    // 2. Call Metrics
    const callHistory = await this.db.callHistory.findMany();
    const callsMade = callHistory.filter((c) => c.outcome !== 'PENDING').length;
    const answeredCalls = callHistory.filter(
      (c) => c.outcome === 'ANSWERED',
    ).length;
    const successRate =
      callsMade > 0 ? Math.round((answeredCalls / callsMade) * 100) : 0;

    const totalDuration = callHistory.reduce(
      (sum, c) => sum + (Number(c.duration) || 0),
      0,
    );
    const averageDuration =
      answeredCalls > 0 ? Math.round(totalDuration / answeredCalls) : 0;

    // 3. Campaign Performance Charts
    const campaigns = await this.db.emailCampaign.findMany({
      include: {
        contacts: true,
      },
    });

    const campaignPerformance = campaigns.map((c) => {
      const campaignContacts = c.contacts || [];
      const campaignSent = campaignContacts.filter((h: any) =>
        this.isSent(h.deliveryStatus),
      ).length;
      const campaignFailed = campaignContacts.filter(
        (h: any) => h.deliveryStatus === 'FAILED',
      ).length;
      const campaignOpens = campaignContacts.filter(
        (h: any) => h.openStatus,
      ).length;
      const campaignReplies = campaignContacts.filter(
        (h: any) => h.replyStatus,
      ).length;

      return {
        name: c.name || 'Untitled Campaign',
        sent: campaignSent,
        failed: campaignFailed,
        opens: campaignOpens,
        replies: campaignReplies,
      };
    });

    // 4. Template Performance
    const templates = await this.db.template.findMany();
    const templatePerformance = templates.map((t) => {
      // Find history linked to campaigns using this template
      const templateHistory = emailHistory.filter(
        (h) => h.campaign?.templateId === t.id,
      );
      const tSent = templateHistory.filter((h) =>
        this.isSent(h.deliveryStatus),
      ).length;
      const tOpens = templateHistory.filter((h) => h.openStatus).length;
      const tReplies = templateHistory.filter((h) => h.replyStatus).length;
      const tOpenRate = tSent > 0 ? Math.round((tOpens / tSent) * 100) : 0;
      const tReplyRate = tSent > 0 ? Math.round((tReplies / tSent) * 100) : 0;

      return {
        name: t.name || 'Untitled Template',
        sent: tSent,
        openRate: tOpenRate,
        replyRate: tReplyRate,
      };
    });

    // 5. Contact Segment Performance (grouped by company or job title)
    // Grouping by company
    const companySegments: Record<
      string,
      { sent: number; opens: number; replies: number }
    > = {};
    emailHistory.forEach((h) => {
      const companyName =
        h.contact?.company ||
        (h.contact ? 'Unknown / Freelance' : 'Removed Contact');
      if (!companySegments[companyName]) {
        companySegments[companyName] = { sent: 0, opens: 0, replies: 0 };
      }
      if (this.isSent(h.deliveryStatus)) {
        companySegments[companyName].sent += 1;
        if (h.openStatus) companySegments[companyName].opens += 1;
        if (h.replyStatus) companySegments[companyName].replies += 1;
      }
    });

    const segmentPerformance = Object.entries(companySegments)
      .map(([company, data]) => {
        const openRate =
          data.sent > 0 ? Math.round((data.opens / data.sent) * 100) : 0;
        const replyRate =
          data.sent > 0 ? Math.round((data.replies / data.sent) * 100) : 0;
        return {
          segment: company,
          sent: data.sent,
          openRate,
          replyRate,
        };
      })
      .sort((a, b) => b.sent - a.sent)
      .slice(0, 5);

    return {
      emailMetrics: {
        sent: sentCount,
        // SES delivery receipts are not tracked, so accepted-by-SES counts as delivered.
        delivered: sentCount,
        failed: failedCount,
        openRate,
        replyRate,
      },
      callingMetrics: {
        callsMade,
        successRate,
        averageDuration,
      },
      campaignPerformance,
      templatePerformance: templatePerformance.filter((t) => t.sent > 0),
      segmentPerformance,
    };
  }

  private isSent(status?: string) {
    return status === 'SENT' || status === 'DELIVERED';
  }
}
