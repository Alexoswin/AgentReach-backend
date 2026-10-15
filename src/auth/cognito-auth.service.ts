import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  FetchError,
  JwksNotAvailableInCacheError,
  JwksValidationError,
  JwtBaseError,
  JwtExpiredError,
} from 'aws-jwt-verify/error';

export type GoogleIdentity = {
  // Google's own ID for the account, which stays the same if the user pool
  // is ever recreated (the Cognito `sub` would not).
  googleId: string;
  email: string;
  name?: string;
};

type IdTokenVerifier = { verify(token: string): Promise<Record<string, any>> };

/**
 * Verifies the Cognito ID token the browser gets after "Sign in with Google"
 * through the Cognito user pool, and returns the Google identity in it.
 */
@Injectable()
export class CognitoAuthService {
  private readonly logger = new Logger(CognitoAuthService.name);
  private verifier: IdTokenVerifier | null = null;

  constructor(private configService: ConfigService) {}

  isConfigured() {
    return Boolean(
      this.configService.get<string>('COGNITO_USER_POOL_ID') &&
      this.configService.get<string>('COGNITO_CLIENT_ID'),
    );
  }

  async verifyGoogleIdToken(
    idToken: string,
    nonce?: string,
  ): Promise<GoogleIdentity> {
    const verifier = this.getVerifier();
    let payload: Record<string, any>;
    try {
      payload = await verifier.verify(idToken);
    } catch (error) {
      if (
        error instanceof FetchError ||
        error instanceof JwksValidationError ||
        error instanceof JwksNotAvailableInCacheError ||
        !(error instanceof JwtBaseError)
      ) {
        this.logger.error(
          `Could not verify Cognito ID token: ${(error as Error).message}`,
        );
        throw new ServiceUnavailableException(
          'Google sign-in is temporarily unavailable. Try again or use your password.',
        );
      }
      this.logger.warn(`Rejected Cognito ID token: ${error.message}`);
      throw new UnauthorizedException(
        error instanceof JwtExpiredError
          ? 'The Google sign-in has expired. Try again.'
          : 'The Google sign-in token is invalid.',
      );
    }

    // The nonce ties the token to the sign-in this browser started.
    if (nonce !== undefined && payload.nonce !== nonce) {
      throw new UnauthorizedException('The Google sign-in token is invalid.');
    }

    const identities: { providerName?: string; userId?: string }[] =
      Array.isArray(payload.identities) ? payload.identities : [];
    const google = identities.find(
      (identity) => identity.providerName === 'Google',
    );
    if (!google?.userId) {
      throw new UnauthorizedException('Only Google sign-in is enabled.');
    }
    // Federated attributes arrive as strings.
    const emailVerified =
      payload.email_verified === true || payload.email_verified === 'true';
    const email = String(payload.email || '')
      .trim()
      .toLowerCase();
    if (!email || !emailVerified) {
      throw new UnauthorizedException('A verified Google email is required.');
    }

    const name =
      String(payload.name || '').trim() ||
      `${payload.given_name || ''} ${payload.family_name || ''}`.trim() ||
      undefined;
    return { googleId: String(google.userId), email, name };
  }

  private getVerifier(): IdTokenVerifier {
    if (this.verifier) return this.verifier;
    const userPoolId = this.configService.get<string>('COGNITO_USER_POOL_ID');
    const clientId = this.configService.get<string>('COGNITO_CLIENT_ID');
    if (!userPoolId || !clientId) {
      throw new ServiceUnavailableException(
        'Google sign-in is not configured for this environment.',
      );
    }
    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: 'id',
    });
    return this.verifier;
  }
}
