import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_TOP_K,
  EMBEDDING_BATCH_SIZE,
  GoogleVoiceProfile,
  MAX_TOP_K,
  MAX_TRAINING_PDF_BYTES,
  MIN_TRAINING_TEXT_LENGTH,
} from './ai-calling-bots.constants';
import {
  readBooleanConfig,
  readJsonConfig,
  readNumberConfig,
  readStringConfig,
} from '../ai-calling/ai-calling-runtime';
import { clampNumber } from './ai-calling-bots.training-utils';

export function getGoogleVoiceProfiles(
  configService?: ConfigService,
): GoogleVoiceProfile[] {
  const custom = readJsonConfig<GoogleVoiceProfile[]>(
    configService,
    'AI_CALLING_VOICE_PROFILES_JSON',
  );
  if (Array.isArray(custom) && custom.length) {
    const sanitized = custom
      .map((item): GoogleVoiceProfile => {
        const gender: GoogleVoiceProfile['gender'] =
          item?.gender === 'female' ? 'female' : 'male';
        return {
          id: String(item?.id || '').trim(),
          label: String(item?.label || '').trim(),
          language: String(item?.language || '').trim(),
          voice: String(item?.voice || '').trim(),
          twilioFallbackVoice: String(item?.twilioFallbackVoice || '').trim(),
          accent: String(item?.accent || '').trim(),
          gender,
        };
      })
      .filter(
        (item) =>
          item.id &&
          item.label &&
          item.language &&
          item.voice &&
          item.twilioFallbackVoice,
      );
    if (sanitized.length) return sanitized;
  }
  return [
    {
      id: 'indian_english',
      label: 'Indian English',
      language: 'en-IN',
      voice: 'google:en-IN-Chirp3-HD-Puck',
      twilioFallbackVoice: 'Google.en-IN-Wavenet-D',
      accent: 'Indian Accent',
      gender: 'male',
    },
    {
      id: 'hindi',
      label: 'Hindi',
      language: 'hi-IN',
      voice: 'google:hi-IN-Chirp3-HD-Puck',
      twilioFallbackVoice: 'Google.hi-IN-Neural2-C',
      accent: 'Indian Accent',
      gender: 'male',
    },
    {
      id: 'english',
      label: 'English',
      language: 'en-US',
      voice: 'google:en-US-Chirp3-HD-Puck',
      twilioFallbackVoice: 'Google.en-US-Neural2-D',
      accent: 'American Accent',
      gender: 'male',
    },
  ];
}

export function shouldUseFastPathReply(
  configService: ConfigService | undefined,
  message: string,
  history: string,
) {
  if (!readBooleanConfig(configService, 'AI_CALLING_FAST_PATH_ENABLED', true)) {
    return false;
  }
  if (history.trim()) return false;
  const lowered = message.toLowerCase();
  return (
    /\b(hi|hello|hey|good morning|good afternoon|good evening|namaste)\b/.test(
      lowered,
    ) ||
    /\b(thanks|thank you|thx)\b/.test(lowered) ||
    /\b(who are you|introduce yourself|what is your name)\b/.test(lowered)
  );
}

export function getDefaultChunkSize(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(
      configService,
      'AI_CALLING_TRAIN_CHUNK_SIZE',
      DEFAULT_CHUNK_SIZE,
    ),
    300,
    1600,
    DEFAULT_CHUNK_SIZE,
  );
}

export function getDefaultChunkOverlap(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(
      configService,
      'AI_CALLING_TRAIN_CHUNK_OVERLAP',
      DEFAULT_CHUNK_OVERLAP,
    ),
    0,
    400,
    DEFAULT_CHUNK_OVERLAP,
  );
}

export function getMaxTopK(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(configService, 'AI_CALLING_MAX_TOP_K', MAX_TOP_K),
    1,
    16,
    MAX_TOP_K,
  );
}

export function getDefaultTopK(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(configService, 'AI_CALLING_DEFAULT_TOP_K', DEFAULT_TOP_K),
    1,
    getMaxTopK(configService),
    DEFAULT_TOP_K,
  );
}

export function getRacHistoryLineLimit(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(configService, 'AI_CALLING_RAC_HISTORY_LINE_LIMIT', 6),
    1,
    20,
    6,
  );
}

export function getMaxTrainingPdfBytes(configService?: ConfigService) {
  return Math.floor(
    readNumberConfig(
      configService,
      'AI_CALLING_MAX_TRAINING_PDF_BYTES',
      MAX_TRAINING_PDF_BYTES,
      1024 * 1024,
    ),
  );
}

export function getMinTrainingTextLength(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(
      configService,
      'AI_CALLING_MIN_TRAINING_TEXT_LENGTH',
      MIN_TRAINING_TEXT_LENGTH,
    ),
    20,
    1000,
    MIN_TRAINING_TEXT_LENGTH,
  );
}

export function getEmbeddingBatchSize(configService?: ConfigService) {
  return clampNumber(
    readNumberConfig(
      configService,
      'AI_CALLING_EMBEDDING_BATCH_SIZE',
      EMBEDDING_BATCH_SIZE,
    ),
    1,
    128,
    EMBEDDING_BATCH_SIZE,
  );
}

export function getChatModel(configService?: ConfigService) {
  return (
    configService?.get<string>('GEMINI_CHAT_MODEL')?.trim() ||
    configService?.get<string>('AI_CALLING_CHAT_MODEL')?.trim() ||
    configService?.get<string>('VERTEX_CHAT_MODEL')?.trim() ||
    configService?.get<string>('VERTEX_AI_MODEL')?.trim() ||
    configService?.get<string>('GOOGLE_VERTEX_MODEL')?.trim() ||
    DEFAULT_CHAT_MODEL
  );
}

export function getEmbeddingModel(configService?: ConfigService) {
  return (
    configService?.get<string>('GEMINI_EMBEDDING_MODEL')?.trim() ||
    configService?.get<string>('AI_CALLING_EMBEDDING_MODEL')?.trim() ||
    configService?.get<string>('VERTEX_EMBEDDING_MODEL')?.trim() ||
    DEFAULT_EMBEDDING_MODEL
  );
}

export function getDefaultVoice(configService?: ConfigService) {
  const profileVoice = getGoogleVoiceProfiles(configService)[0]?.voice;
  return readStringConfig(
    configService,
    'AI_CALLING_DEFAULT_VOICE',
    profileVoice || 'google:en-IN-Chirp3-HD-Puck',
  );
}
