/**
 * Cheap Gemini text model used for all server-side text generation
 * (email template copywriting, etc.). `gemini-2.5-flash-lite` is the
 * lowest-cost Gemini text model.
 */
export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-2.5-flash-lite';

/**
 * Older/retired model ids that should transparently fall back to the current
 * cheap default.
 */
export const RETIRED_TEXT_MODELS = new Set([
  'nex-agi/nex-n2-pro:free',
  'meta-llama/llama-3-8b-instruct:free',
]);

export function resolveGeminiTextModel(model?: string | null) {
  const normalizedModel = model?.trim();

  if (
    !normalizedModel ||
    normalizedModel.includes('/') || // retired slash-delimited model ids
    RETIRED_TEXT_MODELS.has(normalizedModel)
  ) {
    return DEFAULT_GEMINI_TEXT_MODEL;
  }

  return normalizedModel;
}
