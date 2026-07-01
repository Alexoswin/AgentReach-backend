import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SettingsModule } from '../settings/settings.module';
import { EmailCampaignsModule } from '../email-campaigns/email-campaigns.module';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { SignalClassifierService } from './signal-classifier.service';
import { MatchingService } from './matching.service';
import { PlaybooksService } from './playbooks.service';
import { TriggerService } from './trigger.service';
import { IngestionService } from './ingestion.service';
import { SchedulerService } from './scheduler.service';
import { WatchService } from './watch.service';
import { NewsRssCollector } from './collectors/news-rss.collector';
import { EdgarCollector } from './collectors/edgar.collector';
import { JobBoardCollector } from './collectors/job-board.collector';
import { SesBounceCollector } from './collectors/ses-bounce.collector';

@Module({
  imports: [ScheduleModule.forRoot(), SettingsModule, EmailCampaignsModule],
  controllers: [SignalsController],
  providers: [
    SignalsService,
    SignalClassifierService,
    MatchingService,
    PlaybooksService,
    TriggerService,
    IngestionService,
    SchedulerService,
    WatchService,
    NewsRssCollector,
    EdgarCollector,
    JobBoardCollector,
    SesBounceCollector,
  ],
  exports: [WatchService],
})
export class SignalsModule {}
