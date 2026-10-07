import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedHash?: string | null,
) {
  if (!storedHash) return false;
  const [algorithm, salt, key] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !salt || !key) return false;

  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  const storedKey = Buffer.from(key, 'hex');

  return (
    storedKey.length === derivedKey.length &&
    timingSafeEqual(storedKey, derivedKey)
  );
}
