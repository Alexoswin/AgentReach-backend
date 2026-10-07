import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DecodedIdToken } from 'firebase-admin/auth';

@Injectable()
export class IdentityPlatformService {
  constructor(private configService: ConfigService) {}

  async verifyGoogleIdToken(idToken: string): Promise<DecodedIdToken> {
    // Load the Admin SDK auth module only when this flow is used. This keeps
    // normal password-auth tests and development startup independent of the
    // SDK's optional ESM-only JWT dependency.
    const [{ getApps, initializeApp }, { getAuth }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/auth'),
    ]);
    const projectId =
      this.configService.get<string>('FIREBASE_PROJECT_ID') ||
      this.configService.get<string>('GOOGLE_CLOUD_PROJECT') ||
      this.configService.get<string>('GCP_PROJECT');

    if (!projectId) {
      throw new Error(
        'FIREBASE_PROJECT_ID or GOOGLE_CLOUD_PROJECT must be configured for Google sign-in.',
      );
    }

    const app =
      getApps()[0] ||
      initializeApp({
        projectId,
      });

    try {
      const decoded = await getAuth(app).verifyIdToken(idToken, true);
      const provider = decoded.firebase?.sign_in_provider;
      if (provider !== 'google.com') {
        throw new UnauthorizedException('Only Google sign-in is enabled.');
      }
      if (!decoded.email || decoded.email_verified !== true) {
        throw new UnauthorizedException('A verified Google email is required.');
      }
      return decoded;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException(
        'The Google sign-in token is invalid or expired.',
      );
    }
  }
}
