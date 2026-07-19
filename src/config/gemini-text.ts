/**
 * Cheap Gemini text model used for all server-side text generation
 * (email template copywriting, etc.). `gemini-flash-lite-latest` is a
 * Google-managed alias that always points at the current cheap/fast Gemini
 * model, so it does not need to be manually bumped every time a dated model
 * (e.g. `gemini-2.0-flash`, `gemini-2.5-flash-lite`) gets retired.
 */
export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-flash-lite-latest';

/**
 * Older/retired model ids that should transparently fall back to the current
 * cheap default.
 */
export const RETIRED_TEXT_MODELS = new Set([
  'nex-agi/nex-n2-pro:free',
  'meta-llama/llama-3-8b-instruct:free',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite',
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
