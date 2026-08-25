import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MongoModule } from './mongo.module';
import { SettingsModule } from './settings/settings.module';
import { ContactsModule } from './contacts/contacts.module';
import { TemplatesModule } from './templates/templates.module';
import { EmailCampaignsModule } from './email-campaigns/email-campaigns.module';
import { CallingCampaignsModule } from './calling-campaigns/calling-campaigns.module';
import { RealtimeCallingModule } from './realtime-calling/realtime-calling.module';
import { HistoryModule } from './history/history.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { BotModule } from './bot/bot.module';
import { SignalsModule } from './signals/signals.module';
import { CampaignSchedulerModule } from './scheduler/campaign-scheduler.module';
import { WebPilotModule } from './webpilot/webpilot.module';
import { TradeAgentModule } from './trade-agent/trade-agent.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri:
          configService.get<string>('DATABASE_URL') ||
          'mongodb://localhost:27017/reachconvert',
      }),
    }),
    MongoModule,
    AuthModule,
    SettingsModule,
    ContactsModule,
    TemplatesModule,
    EmailCampaignsModule,
    BotModule,
    CallingCampaignsModule,
    RealtimeCallingModule,
    HistoryModule,
    AnalyticsModule,
    SignalsModule,
    CampaignSchedulerModule,
    WebPilotModule,
    TradeAgentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
