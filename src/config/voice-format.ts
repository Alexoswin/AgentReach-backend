export const DEFAULT_HD_VOICE_NAME = 'Puck';

// Matches a bare Chirp3-HD voice id, e.g. "en-IN-Chirp3-HD-Puck". The language
// segment allows 2-3 lowercase letters so future macrolanguage codes (e.g.
// "fil-PH") normalize the same way as today's 2-letter codes.
export const HD_VOICE_ID_PATTERN =
  /^[a-z]{2,3}-[A-Z]{2}-Chirp3-HD-([A-Za-z]+)$/;

// Pulls the bare voice name ("Puck") out of a voice id in any of the shapes
// campaigns/calls store it in: "google:en-IN-Chirp3-HD-Puck", the same
// without the "google:" prefix, or just "Puck".
export function extractHdVoiceName(voice?: string): string {
  const raw = String(voice || '')
    .trim()
    .replace(/^google:/i, '');
  const match = raw.match(HD_VOICE_ID_PATTERN);
  const name = match?.[1] || raw.split('-').at(-1) || DEFAULT_HD_VOICE_NAME;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Rewrites a voice id to the given language while preserving whichever voice
// name it already specified (falling back to the default voice).
export function normalizeGoogleVoiceForLanguage(
  voice: string | undefined,
  language: string,
): string {
  const withoutProvider = String(voice || '')
    .trim()
    .replace(/^google:/i, '');
  const match = withoutProvider.match(HD_VOICE_ID_PATTERN);
  const voiceName =
    match?.[1] || withoutProvider.split('-').at(-1) || DEFAULT_HD_VOICE_NAME;
  return `google:${language}-Chirp3-HD-${voiceName}`;
}
