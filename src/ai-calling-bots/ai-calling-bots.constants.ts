export type TrainingPdfFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

export const EMBEDDING_DIMENSIONS = 384;
export const DEFAULT_CHUNK_SIZE = 900;
export const DEFAULT_CHUNK_OVERLAP = 120;
export const MAX_TRAINING_PDF_BYTES = 8 * 1024 * 1024;
export const MIN_TRAINING_TEXT_LENGTH = 40;
export const EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_CHAT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
export const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 10;
export const DEFAULT_PROMPT_EXPOSURE_TERMS = [
  'system prompt',
  'prompt',
  'instructions',
  'hidden instructions',
  'developer message',
  'jailbreak',
  'ignore previous',
  'reveal your rules',
  'show your rules',
];

export type RetrievedKnowledge = {
  id?: string;
  content: string;
  score: number;
  metadata?: Record<string, any>;
};

export type GoogleVoiceProfile = {
  id: string;
  label: string;
  language: string;
  voice: string;
  twilioFallbackVoice: string;
  accent: string;
  gender: 'male' | 'female';
};
