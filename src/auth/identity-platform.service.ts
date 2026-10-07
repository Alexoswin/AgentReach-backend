import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DecodedIdToken } from 'firebase-admin/auth';

// Admin SDK error codes that mean the caller sent a bad, expired or revoked
// token. Anything else (missing IAM permission, wrong project, network) is a
// server-side problem and must not be reported to the user as a bad token.
const TOKEN_ERROR_MESSAGES: Record<string, string> = {
  'auth/id-token-expired': 'The Google sign-in token has expired. Try again.',
  'auth/id-token-revoked':
    'The Google sign-in session was revoked. Sign in with Google again.',
  'auth/user-disabled': 'This Google account is disabled in Identity Platform.',
  'auth/user-not-found':
    'This Google account was removed from Identity Platform. Sign in with Google again.',
  'auth/argument-error': 'The Google sign-in token is invalid.',
  'auth/invalid-argument': 'The Google sign-in token is invalid.',
  'auth/invalid-id-token': 'The Google sign-in token is invalid.',
};

@Injectable()
export class IdentityPlatformService {
  private readonly logger = new Logger(IdentityPlatformService.name);

  constructor(private configService: ConfigService) {}

  async verifyGoogleIdToken(idToken: string): Promise<DecodedIdToken> {
    const { getApps, initializeApp, getAuth } = await this.loadAdminSdk();
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

    let decoded: DecodedIdToken;
    try {
      decoded = await getAuth(app).verifyIdToken(idToken, true);
    } catch (error: any) {
      const code = String(error?.code || error?.errorInfo?.code || '');
      const tokenMessage = TOKEN_ERROR_MESSAGES[code];
      if (tokenMessage) {
        this.logger.warn(`Rejected Google ID token (${code}).`);
        throw new UnauthorizedException(tokenMessage);
      }
      // Previously every failure was reported as an invalid token, which hid
      // deployment problems such as a runtime service account without
      // firebaseauth.users.get (needed for the revocation check).
      this.logger.error(
        `Could not verify Google ID token${code ? ` (${code})` : ''}: ${
          error?.message || error
        }`,
      );
      throw new ServiceUnavailableException(
        'Google sign-in is temporarily unavailable. Try again or use your password.',
      );
    }

    const provider = decoded.firebase?.sign_in_provider;
    if (provider !== 'google.com') {
      throw new UnauthorizedException('Only Google sign-in is enabled.');
    }
    if (!decoded.email || decoded.email_verified !== true) {
      throw new UnauthorizedException('A verified Google email is required.');
    }
    return decoded;
  }

  // Load the Admin SDK auth module only when this flow is used. This keeps
  // normal password-auth tests and development startup independent of the
  // SDK's optional ESM-only JWT dependency.
  protected async loadAdminSdk() {
    const [{ getApps, initializeApp }, { getAuth }] = await Promise.all([
      import('firebase-admin/app'),
      import('firebase-admin/auth'),
    ]);
    return { getApps, initializeApp, getAuth };
  }
}
