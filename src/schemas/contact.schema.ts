import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ContactDocument = Contact & Document;

@Schema({ collection: 'Contact', timestamps: true })
export class Contact {
  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop()
  company?: string;

  @Prop()
  jobTitle?: string;

  @Prop()
  linkedinUrl?: string;

  @Prop()
  phoneNumber?: string;

  @Prop()
  notes?: string;

  // Stored as a plain object (key-value custom fields)
  @Prop({ type: Object, default: {} })
  customFields?: Record<string, any>;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);
