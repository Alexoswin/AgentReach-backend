import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'Template', timestamps: true })
export class Template {
  @Prop({ default: () => randomUUID() })
  _id: string;

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

  @Prop({ required: true })
  bodyHtml: string;

  @Prop({ required: true })
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
