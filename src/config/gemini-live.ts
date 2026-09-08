/**
 * Gemini Live (voice/bidiGenerateContent) models available for AI calling.
 * Unlike the text API, Live model support is narrow and not every model id
 * that exists for text generation works here — a free-text field let campaigns
 * save nonexistent ids (e.g. `gemini-3.1-flash-native-audio-preview-12-2025`)
 * that only fail at call time. This enum is the single source of truth; the
 * frontend mirrors it as a dropdown instead of a text input so an invalid id
 * can no longer be saved.
 */
export enum GeminiLiveModel {
  FlashLivePreview = 'gemini-3.1-flash-live-preview',
  FlashNativeAudioPreview = 'gemini-2.5-flash-native-audio-preview-12-2025',
}

export const DEFAULT_GEMINI_LIVE_MODEL = GeminiLiveModel.FlashLivePreview;

export const GEMINI_LIVE_MODEL_OPTIONS: Array<{
  value: GeminiLiveModel;
  label: string;
}> = [
  { value: GeminiLiveModel.FlashLivePreview, label: 'Flash Live (preview)' },
  {
    value: GeminiLiveModel.FlashNativeAudioPreview,
    label: 'Flash Native Audio (preview)',
  },
];
