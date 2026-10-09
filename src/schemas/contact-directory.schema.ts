import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'ContactDirectory', timestamps: true })
export class ContactDirectory {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  // Unique per owner (see the compound index below), not globally.
  @Prop({ required: true, trim: true })
  name: string;

  @Prop()
  description?: string;
}

export const ContactDirectorySchema =
  SchemaFactory.createForClass(ContactDirectory);
ContactDirectorySchema.index({ ownerId: 1, name: 1 }, { unique: true });
