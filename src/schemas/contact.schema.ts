import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { randomUUID } from 'crypto';

export type ContactDocument = Contact & Document;

@Schema({ collection: 'Contact', timestamps: true })
export class Contact {
  @Prop({ default: () => randomUUID() })
  _id: string;

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

  @Prop({ type: String, ref: 'ContactDirectory', index: true })
  directoryId?: string;

  // Stored as a JSON string for compatibility with the current import/interpolation code.
  @Prop()
  customFields?: string;
}

export const ContactSchema = SchemaFactory.createForClass(Contact);
