type ConfigReader = {
  get<T = string>(key: string, defaultValue?: T): T | undefined;
};

function readRawValue(config: ConfigReader | undefined, key: string) {
  const fromConfig = config?.get<string | undefined>(key, undefined);
  if (typeof fromConfig === 'string' && fromConfig.trim()) {
    return fromConfig.trim();
  }
  const fromEnv = process.env[key];
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : '';
}

export function readStringConfig(
  config: ConfigReader | undefined,
  key: string,
  fallback: string,
) {
  return readRawValue(config, key) || fallback;
}

export function readNumberConfig(
  config: ConfigReader | undefined,
  key: string,
  fallback: number,
  min?: number,
  max?: number,
) {
  const raw = readRawValue(config, key);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized =
    min !== undefined ? Math.max(min, parsed) : parsed;
  return max !== undefined ? Math.min(max, normalized) : normalized;
}

export function readBooleanConfig(
  config: ConfigReader | undefined,
  key: string,
  fallback: boolean,
) {
  const raw = readRawValue(config, key).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function readStringListConfig(
  config: ConfigReader | undefined,
  key: string,
  fallback: string[],
) {
  const raw = readRawValue(config, key);
  if (!raw) return [...fallback];
  const values = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length ? values : [...fallback];
}

export function readJsonConfig<T>(
  config: ConfigReader | undefined,
  key: string,
): T | null {
  const raw = readRawValue(config, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function buildKeywordRegex(keywords: string[]) {
  const escaped = keywords
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return /$^/;
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
}
