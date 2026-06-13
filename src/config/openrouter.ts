export const DEFAULT_OPENROUTER_MODEL = 'nex-agi/nex-n2-pro:free';
export const RETIRED_OPENROUTER_FREE_MODELS = new Set([
  'meta-llama/llama-3-8b-instruct:free',
]);

export function resolveOpenRouterModel(model?: string | null) {
  const normalizedModel = model?.trim();

  if (!normalizedModel || RETIRED_OPENROUTER_FREE_MODELS.has(normalizedModel)) {
    return DEFAULT_OPENROUTER_MODEL;
  }

  return normalizedModel;
}
