import { createSign } from 'crypto';
import { GoogleServiceAccountCredentials } from './ai-calling-bots.constants';

function base64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function signGoogleServiceAccountJwt(
  clientEmail: string,
  privateKey: string,
  scope: string,
) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(
    JSON.stringify({
      iss: clientEmail,
      scope,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsignedJwt = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(unsignedJwt)
    .sign(privateKey);
  return `${unsignedJwt}.${base64Url(signature)}`;
}

export function parseGoogleServiceAccountCredentials(
  serviceAccountJson?: string,
): GoogleServiceAccountCredentials | null {
  if (!serviceAccountJson?.trim()) return null;
  try {
    const credentials = JSON.parse(serviceAccountJson);
    const clientEmail = String(credentials?.client_email || '').trim();
    const privateKey = String(credentials?.private_key || '').trim();
    const projectId = String(credentials?.project_id || '').trim();
    if (!clientEmail || !privateKey || !projectId) return null;
    return { clientEmail, privateKey, projectId };
  } catch {
    return null;
  }
}

export async function requestGoogleAccessToken(
  serviceAccount: GoogleServiceAccountCredentials,
  scope: string,
) {
  const assertion = signGoogleServiceAccountJwt(
    serviceAccount.clientEmail,
    serviceAccount.privateKey,
    scope,
  );
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error(
      String(data?.error_description || data?.error || response.statusText),
    );
  }

  return {
    accessToken: String(data.access_token),
    expiresAt: Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 60) * 1000,
  };
}
