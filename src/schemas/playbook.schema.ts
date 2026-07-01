import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * A rule: "when signal of type X fires for audience Y, launch/queue campaign Z."
 */
@Schema({ collection: 'Playbook', timestamps: true })
export class Playbook {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, trim: true })
  name: string;

  // Signal types this playbook reacts to.
  @Prop({ type: [String], default: [] })
  signalTypes: string[];

  // Directories (audience) this playbook applies to; empty = all contacts.
  @Prop({ type: [String], default: [] })
  directoryIds: string[];

  // Template used to generate the outreach email.
  @Prop({ required: true })
  templateId: string;

  // 'auto' fires immediately for high-confidence matches; 'review' queues them.
  @Prop({ required: true, default: 'review', enum: ['auto', 'review'] })
  mode: string;

  // Guardrails.
  @Prop({ default: 30 })
  cooldownDays: number;

  @Prop({ default: 50 })
  dailyCap: number;

  @Prop({ default: true })
  active: boolean;
}

export const PlaybookSchema = SchemaFactory.createForClass(Playbook);
