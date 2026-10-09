import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'AiCallingBot', timestamps: true })
export class AiCallingBot {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ default: 'en-IN' })
  language: string;

  @Prop({ default: 'google:en-IN-Chirp3-HD-Puck' })
  voice: string;

  @Prop({ default: 'AI calling specialist' })
  role: string;

  @Prop({
    default: 'Understand the contact need and capture a clear next step.',
  })
  goal: string;

  @Prop({ default: 'warm, concise, calm, and naturally conversational' })
  personality: string;

  @Prop()
  botObjective?: string;

  @Prop()
  botGoal?: string;

  @Prop()
  botFlow?: string;

  @Prop()
  knowledgeBaseText?: string;

  @Prop({ default: false })
  contextOutsideKnowledgeBase: boolean;

  @Prop()
  knowledge?: string;

  @Prop({
    default:
      'Ask permission before continuing. Keep the call brief. Do not overpromise.',
  })
  rules: string;

  @Prop({
    default:
      'If the contact is busy, ask for a better callback time. If they are unsure, offer to send details.',
  })
  objectionHandling: string;

  @Prop({
    default:
      'Hi {{firstName}}, this is {{botName}}. I know this is a quick call, so I will be brief.',
  })
  greeting: string;

  @Prop({ default: true })
  ragEnabled: boolean;

  @Prop({ default: 'local-hash-embedding-v1' })
  embeddingModel: string;

  @Prop({ default: 'READY' })
  status: string;

  @Prop({ default: 0 })
  trainingChunkCount: number;

  @Prop()
  lastTrainedAt?: Date;

  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, unknown>;
}

export const AiCallingBotSchema = SchemaFactory.createForClass(AiCallingBot);
