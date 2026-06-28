export type ResponseSpeed = 'fast' | 'balanced' | 'conservative';
export type ActivityDetectionMode = 'manual' | 'automatic';

export type ResponseSpeedPreset = {
  responseSpeed: ResponseSpeed;
  activityDetection: ActivityDetectionMode;
  startOfSpeechSensitivity:
    | 'START_SENSITIVITY_HIGH'
    | 'START_SENSITIVITY_LOW';
  endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH' | 'END_SENSITIVITY_LOW';
  prefixPaddingMs: number;
  silenceDurationMs: number;
  noiseGateDbfs: number;
};

export const DEFAULT_RESPONSE_SPEED: ResponseSpeed = 'fast';

export const RESPONSE_SPEED_PRESETS: Record<ResponseSpeed, ResponseSpeedPreset> =
  {
    fast: {
      responseSpeed: 'fast',
      activityDetection: 'manual',
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
      prefixPaddingMs: 60,
      silenceDurationMs: 180,
      noiseGateDbfs: -50,
    },
    balanced: {
      responseSpeed: 'balanced',
      activityDetection: 'automatic',
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
      prefixPaddingMs: 100,
      silenceDurationMs: 550,
      noiseGateDbfs: -48,
    },
    conservative: {
      responseSpeed: 'conservative',
      activityDetection: 'automatic',
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: 150,
      silenceDurationMs: 800,
      noiseGateDbfs: -45,
    },
  };

export function normalizeResponseSpeed(value: unknown): ResponseSpeed {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'fast' ||
    normalized === 'balanced' ||
    normalized === 'conservative'
  ) {
    return normalized;
  }
  return DEFAULT_RESPONSE_SPEED;
}

export function getResponseSpeedPreset(value: unknown): ResponseSpeedPreset {
  return RESPONSE_SPEED_PRESETS[normalizeResponseSpeed(value)];
}

export function buildAutomaticActivityDetectionConfig(value: unknown) {
  const preset = getResponseSpeedPreset(value);
  if (preset.activityDetection === 'manual') {
    return { disabled: true };
  }
  return {
    disabled: false,
    startOfSpeechSensitivity: preset.startOfSpeechSensitivity,
    endOfSpeechSensitivity: preset.endOfSpeechSensitivity,
    prefixPaddingMs: preset.prefixPaddingMs,
    silenceDurationMs: preset.silenceDurationMs,
  };
}
