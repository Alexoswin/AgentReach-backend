import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getDashboardAnalytics() {
    // 1. Email Metrics
    const emailHistory = await this.prisma.emailCampaignContact.findMany({
      include: {
        campaign: {
          include: { template: true },
        },
        contact: true,
      },
    });

    const sentCount = emailHistory.filter(h => h.deliveryStatus === 'SENT' || h.deliveryStatus === 'DELIVERED').length;
    const failedCount = emailHistory.filter(h => h.deliveryStatus === 'FAILED').length;
    const totalEmailCount = emailHistory.length;

    const openCount = emailHistory.filter(h => h.openStatus).length;
    const replyCount = emailHistory.filter(h => h.replyStatus).length;

    const openRate = sentCount > 0 ? Math.round((openCount / sentCount) * 100) : 0;
    const replyRate = sentCount > 0 ? Math.round((replyCount / sentCount) * 100) : 0;

    // 2. Call Metrics
    const callHistory = await this.prisma.callHistory.findMany();
    const callsMade = callHistory.filter(c => c.outcome !== 'PENDING').length;
    const answeredCalls = callHistory.filter(c => c.outcome === 'ANSWERED').length;
    const successRate = callsMade > 0 ? Math.round((answeredCalls / callsMade) * 100) : 0;

    const totalDuration = callHistory.reduce((sum, c) => sum + c.duration, 0);
    const averageDuration = answeredCalls > 0 ? Math.round(totalDuration / answeredCalls) : 0;

    // 3. Campaign Performance Charts
    const campaigns = await this.prisma.emailCampaign.findMany({
      include: {
        contacts: true,
      },
    });

    const campaignPerformance = campaigns.map(c => {
      const campaignSent = c.contacts.filter(h => h.deliveryStatus === 'SENT' || h.deliveryStatus === 'DELIVERED').length;
      const campaignFailed = c.contacts.filter(h => h.deliveryStatus === 'FAILED').length;
      const campaignOpens = c.contacts.filter(h => h.openStatus).length;
      const campaignReplies = c.contacts.filter(h => h.replyStatus).length;

      return {
        name: c.name,
        sent: campaignSent,
        failed: campaignFailed,
        opens: campaignOpens,
        replies: campaignReplies,
      };
    });

    // 4. Template Performance
    const templates = await this.prisma.template.findMany();
    const templatePerformance = templates.map(t => {
      // Find history linked to campaigns using this template
      const templateHistory = emailHistory.filter(h => h.campaign?.templateId === t.id);
      const tSent = templateHistory.filter(h => h.deliveryStatus === 'SENT' || h.deliveryStatus === 'DELIVERED').length;
      const tOpens = templateHistory.filter(h => h.openStatus).length;
      const tReplies = templateHistory.filter(h => h.replyStatus).length;
      const tOpenRate = tSent > 0 ? Math.round((tOpens / tSent) * 100) : 0;
      const tReplyRate = tSent > 0 ? Math.round((tReplies / tSent) * 100) : 0;

      return {
        name: t.name,
        sent: tSent,
        openRate: tOpenRate,
        replyRate: tReplyRate,
      };
    });

    // 5. Contact Segment Performance (grouped by company or job title)
    // Grouping by company
    const companySegments: Record<string, { sent: number; opens: number; replies: number }> = {};
    emailHistory.forEach(h => {
      const companyName = h.contact.company || 'Unknown / Freelance';
      if (!companySegments[companyName]) {
        companySegments[companyName] = { sent: 0, opens: 0, replies: 0 };
      }
      if (h.deliveryStatus === 'SENT' || h.deliveryStatus === 'DELIVERED') {
        companySegments[companyName].sent += 1;
        if (h.openStatus) companySegments[companyName].opens += 1;
        if (h.replyStatus) companySegments[companyName].replies += 1;
      }
    });

    const segmentPerformance = Object.entries(companySegments).map(([company, data]) => {
      const openRate = data.sent > 0 ? Math.round((data.opens / data.sent) * 100) : 0;
      const replyRate = data.sent > 0 ? Math.round((data.replies / data.sent) * 100) : 0;
      return {
        segment: company,
        sent: data.sent,
        openRate,
        replyRate,
      };
    }).sort((a, b) => b.sent - a.sent).slice(0, 5);

    // Seed mock data for chart visuals if database is completely empty
    if (totalEmailCount === 0 && callsMade === 0) {
      return this.getMockAnalytics();
    }

    return {
      emailMetrics: {
        sent: sentCount,
        delivered: sentCount, // For mock simplicity, delivered == sent
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
      templatePerformance: templatePerformance.filter(t => t.sent > 0),
      segmentPerformance,
    };
  }

  private getMockAnalytics() {
    return {
      emailMetrics: {
        sent: 128,
        delivered: 124,
        failed: 4,
        openRate: 64,
        replyRate: 22,
      },
      callingMetrics: {
        callsMade: 45,
        successRate: 78,
        averageDuration: 84, // seconds
      },
      campaignPerformance: [
        { name: 'SaaS Founder Outreach', sent: 50, failed: 2, opens: 38, replies: 12 },
        { name: 'Hiring Manager Pitch', sent: 40, failed: 1, opens: 28, replies: 9 },
        { name: 'Follow Up Sequence', sent: 38, failed: 1, opens: 18, replies: 7 },
      ],
      templatePerformance: [
        { name: 'Standard Job Application', sent: 50, openRate: 76, replyRate: 24 },
        { name: 'Recruiter Connect', sent: 40, openRate: 70, replyRate: 22 },
        { name: 'Hiring Manager Quick Pitch', sent: 38, openRate: 47, replyRate: 18 },
      ],
      segmentPerformance: [
        { segment: 'Google', sent: 20, openRate: 85, replyRate: 40 },
        { segment: 'Meta', sent: 15, openRate: 80, replyRate: 33 },
        { segment: 'Stripe', sent: 12, openRate: 75, replyRate: 25 },
        { segment: 'TechCorp Startup', sent: 30, openRate: 50, replyRate: 10 },
      ],
    };
  }
}
