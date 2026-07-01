export type LanguageProfile = {
  code: string;
  spokenLanguage: string;
  accent: string;
  instruction: string;
};

const LANGUAGE_PROFILES: Record<string, Omit<LanguageProfile, 'code'>> = {
  'en-IN': {
    spokenLanguage: 'English',
    accent: 'Indian English',
    instruction:
      'Speak casual, natural Indian English — the way everyday people in India speak English on the phone. Use Indian phrasing, rhythm, and intonation (rising tone at end of statements, natural code-switching with Hindi/local words). Sound friendly and conversational, not formal. Examples: "What is it, sir/madam?", "One moment only", "No problem, I will check.", "What all you need?" Use casual fillers like "actually", "basically", "simply". Match the contact\'s energy.',
  },
  'en-US': {
    spokenLanguage: 'English',
    accent: 'American English',
    instruction: 'Use natural American English phrasing and pronunciation.',
  },
  'en-GB': {
    spokenLanguage: 'English',
    accent: 'British English',
    instruction: 'Use natural British English phrasing and pronunciation.',
  },
  'hi-IN': {
    spokenLanguage: 'Hindi',
    accent: 'Casual Hindi (Youth/Teenage)',
    instruction:
      'Speak casual, modern Hindi like teenagers use — relaxed and conversational, not formal. Use Hinglish (Hindi mixed with English words naturally). Common patterns: "Haan, bilkul", "Ek minute", "Basically yeh ek simple cheez hai", "Kya baat hai", "Chill, sab theek hai", "Mujhe bataao what all you need". Use teenage slang and casual fillers: "basically", "arre bhai", "yaar", "literally", "bro". Sound friendly, young, and relatable — like talking to a friend.',
  },
  'bn-IN': {
    spokenLanguage: 'Bengali',
    accent: 'Indian Bengali',
    instruction: 'Speak Bengali naturally.',
  },
  'gu-IN': {
    spokenLanguage: 'Gujarati',
    accent: 'Indian Gujarati',
    instruction: 'Speak Gujarati naturally.',
  },
  'kn-IN': {
    spokenLanguage: 'Kannada',
    accent: 'Indian Kannada',
    instruction: 'Speak Kannada naturally.',
  },
  'ml-IN': {
    spokenLanguage: 'Malayalam',
    accent: 'Indian Malayalam',
    instruction: 'Speak Malayalam naturally.',
  },
  'mr-IN': {
    spokenLanguage: 'Marathi',
    accent: 'Indian Marathi',
    instruction: 'Speak Marathi naturally.',
  },
  'ta-IN': {
    spokenLanguage: 'Tamil',
    accent: 'Indian Tamil',
    instruction: 'Speak Tamil naturally.',
  },
  'te-IN': {
    spokenLanguage: 'Telugu',
    accent: 'Indian Telugu',
    instruction: 'Speak Telugu naturally.',
  },
  'es-ES': {
    spokenLanguage: 'Spanish',
    accent: 'Spain Spanish',
    instruction: 'Speak Spanish naturally for Spain.',
  },
  'es-MX': {
    spokenLanguage: 'Spanish',
    accent: 'Mexican Spanish',
    instruction: 'Speak Spanish naturally for Mexico.',
  },
  'fr-FR': {
    spokenLanguage: 'French',
    accent: 'France French',
    instruction: 'Speak French naturally for France.',
  },
  'fr-CA': {
    spokenLanguage: 'French',
    accent: 'Canadian French',
    instruction: 'Speak French naturally for Canada.',
  },
  'de-DE': {
    spokenLanguage: 'German',
    accent: 'German',
    instruction: 'Speak German naturally.',
  },
  'it-IT': {
    spokenLanguage: 'Italian',
    accent: 'Italian',
    instruction: 'Speak Italian naturally.',
  },
  'pt-BR': {
    spokenLanguage: 'Portuguese',
    accent: 'Brazilian Portuguese',
    instruction: 'Speak Portuguese naturally for Brazil.',
  },
  'sv-SE': {
    spokenLanguage: 'Swedish',
    accent: 'Swedish',
    instruction: 'Speak Swedish naturally.',
  },
  'zh-CN': {
    spokenLanguage: 'Mandarin Chinese',
    accent: 'Mainland Chinese',
    instruction:
      'Speak Mandarin Chinese naturally, using simplified characters.',
  },
  'nl-NL': {
    spokenLanguage: 'Dutch',
    accent: 'Netherlands Dutch',
    instruction:
      'Speak Dutch naturally and directly, as spoken in the Netherlands.',
  },
  'pl-PL': {
    spokenLanguage: 'Polish',
    accent: 'Polish',
    instruction: 'Speak Polish naturally and conversationally.',
  },
  'ru-RU': {
    spokenLanguage: 'Russian',
    accent: 'Russian',
    instruction: 'Speak Russian naturally and clearly.',
  },
  'tr-TR': {
    spokenLanguage: 'Turkish',
    accent: 'Turkish',
    instruction: 'Speak Turkish naturally and conversationally.',
  },
  'el-GR': {
    spokenLanguage: 'Greek',
    accent: 'Greek',
    instruction: 'Speak Greek naturally and conversationally.',
  },
  'cs-CZ': {
    spokenLanguage: 'Czech',
    accent: 'Czech',
    instruction: 'Speak Czech naturally and clearly.',
  },
  'hu-HU': {
    spokenLanguage: 'Hungarian',
    accent: 'Hungarian',
    instruction: 'Speak Hungarian naturally and conversationally.',
  },
  'ro-RO': {
    spokenLanguage: 'Romanian',
    accent: 'Romanian',
    instruction: 'Speak Romanian naturally and conversationally.',
  },
};

export function getLanguageProfile(languageCode?: string): LanguageProfile {
  const code = String(languageCode || 'en-IN').trim() || 'en-IN';
  return {
    code,
    ...(LANGUAGE_PROFILES[code] || {
      spokenLanguage: code,
      accent: code,
      instruction:
        'Follow the selected locale consistently for every spoken turn.',
    }),
  };
}
