import { Injectable } from '@nestjs/common';
import Parser from 'rss-parser';
import { MongoService } from '../../mongo.service';
import { GeminiAgentService } from '../llm/gemini-agent.service';
import { WorkerId } from '../trade-agent.types';
import { BaseWorker, WorkerTask } from './base.worker';

/**
 * Research worker — turns market news into structured events.
 *
 * Runs on the cheaper worker model at low effort: this is high-volume
 * extraction, not judgement. Feeds are public RSS, mirroring how the signals
 * module already collects company news.
 */
@Injectable()
export class ResearchWorker extends BaseWorker {
  readonly id: WorkerId = 'research';
  protected readonly effort = 'low' as const;
  protected readonly maxTokens = 6000;

  private readonly parser = new Parser({ timeout: 12000 });

  private readonly feeds = [
    'https://www.moneycontrol.com/rss/marketreports.xml',
    'https://www.moneycontrol.com/rss/business.xml',
    'https://www.livemint.com/rss/markets',
  ];

  constructor(gemini: GeminiAgentService, db: MongoService) {
    super(gemini, db);
  }

  protected systemPrompt() {
    return [
      'You are a market research analyst on an Indian equities and F&O desk.',
      '',
      'You are given recent market headlines. Extract the ones that plausibly move',
      'specific NSE-listed names, and report them as structured signals.',
      '',
      'Rules:',
      '- Only name a symbol you are confident is the correct NSE trading symbol.',
      '  If you are unsure of the exact symbol, leave it out entirely.',
      '- A headline is not a trade. Most items should produce no signal at all;',
      '  an empty signal list is a good answer on a quiet day.',
      '- Confidence reflects how strongly the evidence supports the direction, not',
      '  how interesting the story is.',
      '- Cite the headline in `evidence`. Never assert a fact the feed did not carry.',
      '- You cannot place orders. Your output is advisory input to a human-reviewed queue.',
    ].join('\n');
  }

  protected async gather(task: WorkerTask) {
    const items: {
      title: string;
      link?: string;
      published?: string;
      source: string;
    }[] = [];

    // One bad feed must not sink the worker.
    const results = await Promise.allSettled(
      this.feeds.map((url) => this.parser.parseURL(url)),
    );

    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      for (const item of result.value.items?.slice(0, 20) ?? []) {
        items.push({
          title: item.title || '',
          link: item.link,
          published: item.isoDate || item.pubDate,
          source: this.feeds[index],
        });
      }
    });

    if (!items.length) {
      return { __skip: 'No market news could be retrieved from any feed.' };
    }

    return {
      headlines: items.filter((item) => item.title).slice(0, 60),
      focusSymbols: task.symbols ?? [],
    };
  }
}
