import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'Contact', timestamps: true })
export class Contact {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  // Unique per owner (see the compound index below), not globally.
  @Prop({ required: true, lowercase: true, trim: true })
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
ContactSchema.index({ ownerId: 1, email: 1 }, { unique: true });
