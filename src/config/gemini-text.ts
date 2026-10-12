/**
 * Cheap Gemini text model used for all server-side text generation
 * (email template copywriting, etc.). `gemini-flash-lite-latest` is a
 * Google-managed alias that always points at the current cheap/fast Gemini
 * model, so it does not need to be manually bumped every time a dated model
 * (e.g. `gemini-2.0-flash`, `gemini-2.5-flash-lite`) gets retired.
 */
export const DEFAULT_GEMINI_TEXT_MODEL = 'gemini-flash-lite-latest';

/**
 * Text models selectable in Settings. The frontend mirrors this list as a
 * dropdown, and the settings DTO rejects anything else, so a mistyped or
 * retired id can no longer be saved.
 */
export const GEMINI_TEXT_MODEL_OPTIONS: Array<{
  value: string;
  label: string;
}> = [
  {
    value: DEFAULT_GEMINI_TEXT_MODEL,
    label: 'Flash-Lite latest (auto-updates)',
  },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
];

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
