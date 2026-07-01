import { Injectable, Logger } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { EmailCampaignsService } from '../email-campaigns/email-campaigns.service';
import { PlaybookLike } from './playbooks.service';
import { SIGNAL_TYPE_LABELS } from './signal.types';

export type TriggerOutcome =
  | 'triggered'
  | 'skipped-cooldown'
  | 'skipped-daily-cap'
  | 'skipped-duplicate';

export interface TriggerResult {
  outcome: TriggerOutcome;
  campaignId?: string;
  triggeredOutreachId?: string;
}

interface SignalLike {
  id: string;
  type: string;
  title: string;
  summary?: string;
  url?: string;
  occurredAt: Date | string;
  companyName?: string;
  classification?: Record<string, any>;
}

/**
 * Turns an approved (signal, contact, playbook) triple into a real, single-
 * contact email campaign — reusing the existing email-campaigns send pipeline.
 * All deliverability guardrails live here.
 */
@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);

  constructor(
    private readonly db: MongoService,
    private readonly emailCampaigns: EmailCampaignsService,
  ) {}

  async trigger(
    signal: SignalLike,
    contactId: string,
    playbook: PlaybookLike,
    matchId?: string,
  ): Promise<TriggerResult> {
    // Guardrail: never trigger the same signal for the same contact twice.
    const dupe = await this.db.triggeredOutreach.findFirst({
      where: { signalId: signal.id, contactId },
    });
    if (dupe) return { outcome: 'skipped-duplicate' };

    // Guardrail: per-contact cooldown window.
    const cooldownStart = new Date(
      Date.now() - playbook.cooldownDays * 24 * 60 * 60 * 1000,
    );
    const recent = await this.db.triggeredOutreach.findFirst({
      where: { contactId, launchedAt: { gte: cooldownStart } },
    });
    if (recent) return { outcome: 'skipped-cooldown' };

    // Guardrail: per-playbook daily send cap.
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayCount = (
      await this.db.triggeredOutreach.findMany({
        where: { playbookId: playbook.id, launchedAt: { gte: startOfDay } },
      })
    ).length;
    if (todayCount >= playbook.dailyCap) {
      return { outcome: 'skipped-daily-cap' };
    }

    // Materialize a signal-specific template so {{signal.*}} placeholders are
    // baked in; contact-level placeholders are filled by the send pipeline.
    const baseTemplate = await this.db.template.findUnique({
      where: { id: playbook.templateId },
    });
    if (!baseTemplate) {
      throw new Error('Playbook template no longer exists');
    }

    const materialized = await this.db.template.create({
      data: {
        name: `[Signal] ${baseTemplate.name} — ${signal.companyName || ''}`.slice(0, 120),
        subject: this.injectSignal(baseTemplate.subject, signal),
        bodyHtml: this.injectSignal(baseTemplate.bodyHtml, signal),
        bodyText: this.injectSignal(baseTemplate.bodyText, signal),
        type: 'CUSTOM',
        category: 'signal-triggered',
        attachments: baseTemplate.attachments || [],
      },
    });

    const campaign = await this.db.emailCampaign.create({
      data: {
        name: `Signal: ${SIGNAL_TYPE_LABELS[signal.type] || signal.type} — ${signal.companyName || ''}`.slice(0, 120),
        status: 'DRAFT',
        templateId: materialized.id,
      },
    });

    await this.emailCampaigns.addContacts(campaign.id, { contactIds: [contactId] });
    await this.emailCampaigns.launchCampaign(campaign.id);

    const record = await this.db.triggeredOutreach.create({
      data: {
        signalId: signal.id,
        contactId,
        playbookId: playbook.id,
        matchId,
        campaignId: campaign.id,
        launchedAt: new Date(),
        outcome: { opened: false, replied: false },
      },
    });

    if (matchId) {
      await this.db.signalMatch.update({
        where: { id: matchId },
        data: { status: 'triggered', campaignId: campaign.id },
      });
    }

    this.logger.log(
      `Triggered outreach for contact ${contactId} on signal ${signal.id} (playbook ${playbook.name})`,
    );

    return {
      outcome: 'triggered',
      campaignId: campaign.id,
      triggeredOutreachId: record.id,
    };
  }

  /** Render a signal-injected preview of a template (used by the review queue). */
  async renderPreview(
    templateId: string,
    signal: SignalLike,
  ): Promise<{ subject: string; bodyText: string }> {
    const template = await this.db.template.findUnique({
      where: { id: templateId },
    });
    if (!template) return { subject: '', bodyText: '' };
    return {
      subject: this.injectSignal(template.subject, signal),
      bodyText: this.injectSignal(
        template.bodyText || template.bodyHtml || '',
        signal,
      ),
    };
  }

  private injectSignal(template: string, signal: SignalLike): string {
    if (!template) return '';
    const date = new Date(signal.occurredAt);
    const entities = signal.classification?.entities || {};
    const map: Record<string, string> = {
      'signal.type': SIGNAL_TYPE_LABELS[signal.type] || signal.type,
      'signal.title': signal.title || '',
      'signal.summary': signal.summary || signal.title || '',
      'signal.url': signal.url || '',
      'signal.date': Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          }),
      'signal.company': signal.companyName || '',
      'signal.detail.roundSize': entities.roundSize || '',
      'signal.detail.roundStage': entities.roundStage || '',
      'signal.detail.roleCount': String(entities.roleCount || ''),
      'signal.detail.product': entities.product || '',
    };

    let result = template;
    for (const [key, value] of Object.entries(map)) {
      const pattern = new RegExp(
        `\\{\\{\\s*${key.replace(/[.]/g, '\\.')}\\s*\\}\\}`,
        'g',
      );
      result = result.replace(pattern, value);
    }
    return result;
  }
}
