import { GoogleGenAI } from '@google/genai';

/**
 * Model selection and client construction for the Trade-Agent.
 *
 * Deliberately DI-free (same role as `config/groww.ts`) and deliberately built
 * on the same `geminiApiKey` the rest of ReachConvert already uses — the desk
 * adds no new credential of its own.
 *
 * Model ids follow the alias convention established in `config/gemini-text.ts`:
 * Google-managed `-latest` aliases rather than dated ids, so a retired model
 * does not silently break the desk.
 */

/** Orchestrator, F&O strategy and equity workers — the judgement-heavy calls. */
export const DEFAULT_TRADE_MASTER_MODEL = 'gemini-pro-latest';

/** Research and technical workers — high volume, cheap. */
export const DEFAULT_TRADE_WORKER_MODEL = 'gemini-flash-latest';

/** Dated ids that should transparently fall back to the current alias. */
export const RETIRED_TRADE_MODELS = new Set([
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-pro',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
]);

export function resolveTradeModel(
  model: string | undefined | null,
  fallback: string,
) {
  const normalized = model?.trim();

  if (
    !normalized ||
    normalized.includes('/') ||
    RETIRED_TRADE_MODELS.has(normalized)
  ) {
    return fallback;
  }

  return normalized;
}

export class GeminiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiConfigError';
  }
}

/**
 * Reads the Gemini key out of decrypted settings, falling back to the
 * environment so a deployment can inject it without the UI.
 */
export function readGeminiApiKey(settings: Record<string, any> | null) {
  return (
    settings?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || ''
  );
}

export function createGeminiClient(apiKey: string): GoogleGenAI {
  if (!apiKey) {
    throw new GeminiConfigError(
      'Gemini is not configured. Add an API key in Settings → Gemini.',
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Effort maps onto Gemini's thinking level, which keeps the desk's
 * "cheap worker / careful strategist" split expressible in one knob.
 */
export type TradeEffort = 'low' | 'medium' | 'high';

export function thinkingLevelFor(effort: TradeEffort) {
  return effort;
}

/** Never contains the key itself — used only for client caching. */
export function geminiFingerprint(apiKey: string) {
  if (!apiKey) return 'unset';
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}:${apiKey.length}`;
}
