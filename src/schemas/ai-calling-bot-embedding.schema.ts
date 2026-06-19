import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { randomUUID } from 'crypto';

export type AiCallingBotEmbeddingDocument = AiCallingBotEmbedding & Document;

@Schema({ collection: 'AiCallingBotEmbedding', timestamps: true })
export class AiCallingBotEmbedding {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  botId: string;

  @Prop({ required: true })
  content: string;

  @Prop({ type: [Number], required: true })
  embedding: number[];

  @Prop({ default: 'local-hash-embedding-v1' })
  embeddingModel: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, unknown>;
}

export const AiCallingBotEmbeddingSchema = SchemaFactory.createForClass(
  AiCallingBotEmbedding,
);
