import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MongoService } from './mongo.service';
import { User, UserSchema } from './schemas/user.schema';
import {
  SystemSettings,
  SystemSettingsSchema,
} from './schemas/system-settings.schema';
import { Contact, ContactSchema } from './schemas/contact.schema';
import {
  ContactDirectory,
  ContactDirectorySchema,
} from './schemas/contact-directory.schema';
import { Template, TemplateSchema } from './schemas/template.schema';
import {
  EmailCampaign,
  EmailCampaignSchema,
} from './schemas/email-campaign.schema';
import {
  EmailCampaignContact,
  EmailCampaignContactSchema,
} from './schemas/email-campaign-contact.schema';
import {
  CallingCampaign,
  CallingCampaignSchema,
} from './schemas/calling-campaign.schema';
import { CallHistory, CallHistorySchema } from './schemas/call-history.schema';
import {
  AiCallingBot,
  AiCallingBotSchema,
} from './schemas/ai-calling-bot.schema';
import {
  AiCallingBotEmbedding,
  AiCallingBotEmbeddingSchema,
} from './schemas/ai-calling-bot-embedding.schema';
import {
  CompanyWatch,
  CompanyWatchSchema,
} from './schemas/company-watch.schema';
import { Signal, SignalSchema } from './schemas/signal.schema';
import { SignalMatch, SignalMatchSchema } from './schemas/signal-match.schema';
import { Playbook, PlaybookSchema } from './schemas/playbook.schema';
import {
  TriggeredOutreach,
  TriggeredOutreachSchema,
} from './schemas/triggered-outreach.schema';
import {
  TradeAgentRun,
  TradeAgentRunSchema,
} from './schemas/trade-agent-run.schema';
import {
  AgentMessage,
  AgentMessageSchema,
} from './schemas/agent-message.schema';
import { TradeSignal, TradeSignalSchema } from './schemas/trade-signal.schema';
import { OrderIntent, OrderIntentSchema } from './schemas/order-intent.schema';
import { TradeOrder, TradeOrderSchema } from './schemas/trade-order.schema';
import {
  PositionSnapshot,
  PositionSnapshotSchema,
} from './schemas/position-snapshot.schema';
import { RiskEvent, RiskEventSchema } from './schemas/risk-event.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: SystemSettings.name, schema: SystemSettingsSchema },
      { name: Contact.name, schema: ContactSchema },
      { name: ContactDirectory.name, schema: ContactDirectorySchema },
      { name: Template.name, schema: TemplateSchema },
      { name: EmailCampaign.name, schema: EmailCampaignSchema },
      { name: EmailCampaignContact.name, schema: EmailCampaignContactSchema },
      { name: CallingCampaign.name, schema: CallingCampaignSchema },
      { name: CallHistory.name, schema: CallHistorySchema },
      { name: AiCallingBot.name, schema: AiCallingBotSchema },
      {
        name: AiCallingBotEmbedding.name,
        schema: AiCallingBotEmbeddingSchema,
      },
      { name: CompanyWatch.name, schema: CompanyWatchSchema },
      { name: Signal.name, schema: SignalSchema },
      { name: SignalMatch.name, schema: SignalMatchSchema },
      { name: Playbook.name, schema: PlaybookSchema },
      { name: TriggeredOutreach.name, schema: TriggeredOutreachSchema },
      { name: TradeAgentRun.name, schema: TradeAgentRunSchema },
      { name: AgentMessage.name, schema: AgentMessageSchema },
      { name: TradeSignal.name, schema: TradeSignalSchema },
      { name: OrderIntent.name, schema: OrderIntentSchema },
      { name: TradeOrder.name, schema: TradeOrderSchema },
      { name: PositionSnapshot.name, schema: PositionSnapshotSchema },
      { name: RiskEvent.name, schema: RiskEventSchema },
    ]),
  ],
  providers: [MongoService],
  exports: [MongoService],
})
export class MongoModule {}
