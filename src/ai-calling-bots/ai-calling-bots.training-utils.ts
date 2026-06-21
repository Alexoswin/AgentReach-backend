import { CreateAiCallingBotDto } from './dto/create-ai-calling-bot.dto';

export function cleanTrainingText(value: string) {
  return value
    .replaceAll('\u0000', '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseMultipartBoolean(value?: string) {
  if (value === undefined || value === '') return undefined;
  return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
}

export function parseMultipartNumber(value?: string) {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeGoogleVoice(
  rawVoice: string,
  language: string | undefined,
  profiles: Array<{ id: string; label: string; language: string; voice: string }>,
  defaultVoice: string,
) {
  const voice = rawVoice.trim();
  if (voice.startsWith('google:')) return voice;
  if (/^[a-z]{2}-[A-Z]{2}-Chirp3-HD-[A-Za-z]+$/.test(voice)) {
    return `google:${voice}`;
  }
  const profile = profiles.find(
    (item) =>
      item.id === voice ||
      item.label.toLowerCase() === voice.toLowerCase() ||
      item.language === language,
  );
  return profile?.voice || defaultVoice;
}

export function normalizeBotPayload(
  dto: Partial<CreateAiCallingBotDto>,
  normalizeVoice: (rawVoice: string, language?: string) => string,
) {
  const data: Record<string, unknown> = {};
  const assignText = (key: keyof CreateAiCallingBotDto) => {
    const value = dto[key];
    if (typeof value === 'string') data[key] = value.trim();
  };

  [
    'name',
    'description',
    'language',
    'role',
    'goal',
    'personality',
    'knowledge',
    'rules',
    'objectionHandling',
    'greeting',
  ].forEach((key) => assignText(key as keyof CreateAiCallingBotDto));

  if (typeof dto.voice === 'string') {
    data.voice = normalizeVoice(dto.voice, dto.language);
  }
  if (typeof dto.ragEnabled === 'boolean') data.ragEnabled = dto.ragEnabled;
  if (dto.metadata && typeof dto.metadata === 'object') {
    data.metadata = dto.metadata;
  }

  return data;
}

export function chunkText(text: string, chunkSize: number, chunkOverlap: number) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(start + chunkSize, normalized.length);
    const softEnd = findChunkEnd(normalized, start, hardEnd);
    chunks.push(normalized.slice(start, softEnd).trim());
    if (softEnd >= normalized.length) break;
    start = Math.max(softEnd - chunkOverlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function findChunkEnd(text: string, start: number, hardEnd: number) {
  if (hardEnd >= text.length) return text.length;
  const slice = text.slice(start, hardEnd);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! '),
  );
  if (sentenceEnd > hardEnd - start - 260) return start + sentenceEnd + 1;
  const space = slice.lastIndexOf(' ');
  return space > 120 ? start + space : hardEnd;
}

export function hashToken(token: string) {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function embedLocally(text: string, dimensions: number) {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1);

  for (const token of tokens) {
    const index = hashToken(token) % dimensions;
    vector[index] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

export function cosineSimilarity(a: number[], b: number[]) {
  if (!a.length || !b.length) return 0;
  const dimensions = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < dimensions; i++) dot += a[i] * b[i];
  return dot;
}

export function clampNumber(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(next)));
}
