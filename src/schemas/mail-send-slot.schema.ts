import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * Per-account send pacing shared by every API task: each send reserves the
 * next free slot, so the rate limit holds however many tasks are sending.
 */
@Schema({ collection: 'MailSendSlot' })
export class MailSendSlot {
  // The owner (sending account) id.
  @Prop()
  _id: string;

  // The slot most recently handed out.
  @Prop({ type: Date, default: null })
  slot?: Date | null;

  @Prop({ type: Date, default: null })
  nextSendAt?: Date | null;
}

export const MailSendSlotSchema = SchemaFactory.createForClass(MailSendSlot);
