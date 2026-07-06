/**
 * Cheap Gemini text model used for all server-side text generation
 * (email template copywriting, etc.). Replaces the previous OpenRouter
 * integration. `gemini-2.5-flash-lite` is the lowest-cost Gemini text model.
 */
export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-2.5-flash-lite';

/**
 * Older/retired model ids that should transparently fall back to the current
 * cheap default (e.g. leftover OpenRouter ids stored in existing settings).
 */
export const RETIRED_TEXT_MODELS = new Set([
  'nex-agi/nex-n2-pro:free',
  'meta-llama/llama-3-8b-instruct:free',
]);

export function resolveGeminiTextModel(model?: string | null) {
  const normalizedModel = model?.trim();

  if (
    !normalizedModel ||
    normalizedModel.includes('/') || // any leftover OpenRouter-style id
    RETIRED_TEXT_MODELS.has(normalizedModel)
  ) {
    return DEFAULT_GEMINI_TEXT_MODEL;
  }

  return normalizedModel;
}
