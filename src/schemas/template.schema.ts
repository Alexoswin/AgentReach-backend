import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'Template', timestamps: true })
export class Template {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  goal?: string;

  @Prop()
  audience?: string;

  @Prop()
  tone?: string;

  @Prop()
  instructions?: string;

  @Prop({ required: true })
  subject: string;

  // A template may be HTML-only or text-only (TemplatesService requires at
  // least one body). `required` would reject the empty string Mongoose sees
  // for the missing one, failing every plain-text save with a 500.
  @Prop({ type: String, default: '' })
  bodyHtml: string;

  @Prop({ type: String, default: '' })
  bodyText: string;

  // 'AI', 'PREDEFINED', 'CUSTOM'
  @Prop({
    required: true,
    enum: ['AI', 'PREDEFINED', 'CUSTOM'],
    default: 'CUSTOM',
  })
  type: string;

  @Prop()
  category?: string;

  @Prop({ type: Array, default: [] })
  attachments?: {
    id: string;
    name: string;
    contentType: string;
    size: number;
    contentBase64: string;
  }[];
}

export const TemplateSchema = SchemaFactory.createForClass(Template);
