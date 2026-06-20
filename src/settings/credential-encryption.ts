import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

export const MASKED_CREDENTIAL = '••••••••••••••••';
export const ENCRYPTED_CREDENTIAL_PREFIX = 'enc:v1:';

export const SYSTEM_CREDENTIAL_FIELDS = [
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'openRouterApiKey',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioPhoneNumber',
  'googleServiceAccountJson',
] as const;

type SystemCredentialField = (typeof SYSTEM_CREDENTIAL_FIELDS)[number];

function getEncryptionKey() {
  const secret =
    process.env.CREDENTIAL_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    process.env.DATABASE_URL ||
    'reachconvert-local-credential-key';
  return createHash('sha256').update(secret).digest();
}

function isSystemCredentialField(key: string): key is SystemCredentialField {
  return SYSTEM_CREDENTIAL_FIELDS.includes(key as SystemCredentialField);
}

export function isEncryptedCredential(value: unknown) {
  return (
    typeof value === 'string' && value.startsWith(ENCRYPTED_CREDENTIAL_PREFIX)
  );
}

export function encryptCredential(value: unknown) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    isEncryptedCredential(value)
  ) {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTED_CREDENTIAL_PREFIX}${Buffer.concat([
    iv,
    tag,
    encrypted,
  ]).toString('base64')}`;
}

export function decryptCredential(value: unknown) {
  if (!isEncryptedCredential(value)) return value;

  try {
    const payload = Buffer.from(
      value.slice(ENCRYPTED_CREDENTIAL_PREFIX.length),
      'base64',
    );
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

export function encryptSystemSettingsData<T extends Record<string, any>>(
  data: T,
) {
  const encrypted: Record<string, any> = { ...data };
  for (const key of Object.keys(encrypted)) {
    if (isSystemCredentialField(key)) {
      encrypted[key] = encryptCredential(encrypted[key]);
    }
  }
  return encrypted as T;
}

export function decryptSystemSettings<T extends Record<string, any> | null>(
  settings: T,
): T {
  if (!settings) return settings;
  const decrypted: Record<string, any> = { ...settings };
  for (const key of Object.keys(decrypted)) {
    if (isSystemCredentialField(key)) {
      decrypted[key] = decryptCredential(decrypted[key]);
    }
  }
  return decrypted as T;
}

export function maskSystemSettings<T extends Record<string, any> | null>(
  settings: T,
): T {
  if (!settings) return settings;
  const masked: Record<string, any> = { ...settings };
  for (const key of SYSTEM_CREDENTIAL_FIELDS) {
    if (masked[key]) masked[key] = MASKED_CREDENTIAL;
  }
  return masked as T;
}
