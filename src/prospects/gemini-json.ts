import { GoogleGenAI } from '@google/genai';

export type GeminiJson = (prompt: string) => Promise<unknown>;

export function createGeminiJson(apiKey: string, model: string): GeminiJson {
  const ai = new GoogleGenAI({ apiKey });
  return async (prompt) => {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    return parseJson(response.text || '');
  };
}

export function parseJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```json/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  if (!cleaned) throw new Error('Empty response received from Gemini');
  return JSON.parse(cleaned);
}
