import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * One signed-in device. The refresh token rotates on every use; the hash it
 * replaced is kept briefly so two tabs refreshing at the same moment do not
 * sign each other out.
 */
@Schema({ collection: 'AuthSession', timestamps: true })
export class AuthSession {
  @Prop({ required: true })
  _id: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ required: true })
  refreshTokenHash: string;

  @Prop({ type: String, default: null })
  previousRefreshTokenHash?: string | null;

  @Prop({ type: Date, default: null })
  rotatedAt?: Date | null;

  @Prop({ type: Date, required: true })
  expiresAt: Date;
}

export const AuthSessionSchema = SchemaFactory.createForClass(AuthSession);
// MongoDB removes a session once its refresh token can no longer be used.
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
