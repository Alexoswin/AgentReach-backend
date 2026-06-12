import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma.module';
import { SettingsModule } from './settings/settings.module';
import { ContactsModule } from './contacts/contacts.module';
import { TemplatesModule } from './templates/templates.module';
import { EmailCampaignsModule } from './email-campaigns/email-campaigns.module';
import { CallingCampaignsModule } from './calling-campaigns/calling-campaigns.module';
import { HistoryModule } from './history/history.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    SettingsModule,
    ContactsModule,
    TemplatesModule,
    EmailCampaignsModule,
    CallingCampaignsModule,
    HistoryModule,
    AnalyticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
