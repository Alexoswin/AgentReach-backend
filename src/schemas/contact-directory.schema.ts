import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'ContactDirectory', timestamps: true })
export class ContactDirectory {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, unique: true, trim: true })
  name: string;

  @Prop()
  description?: string;
}

export const ContactDirectorySchema =
  SchemaFactory.createForClass(ContactDirectory);
