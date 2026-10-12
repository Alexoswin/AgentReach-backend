import { DEFAULT_GEMINI_TEXT_MODEL } from '../config/gemini-text';

export type WebSearchResult = {
  answer: string;
  sources: Array<{ title: string; url: string }>;
};

// One-shot Gemini text call grounded with Google Search. The answer is read
// aloud by the live voice agent, so it is kept short and speakable.
export async function runWebSearchAgent(
  apiKey: string,
  query: string,
): Promise<WebSearchResult> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: DEFAULT_GEMINI_TEXT_MODEL,
    contents: [
      'You are a web research assistant for a live phone agent.',
      'Search the web and answer the question below in at most three short, plain sentences that can be spoken aloud.',
      'No markdown, lists, or URLs. If the results do not answer it, say so plainly.',
      '',
      `Question: ${query}`,
    ].join('\n'),
    config: { tools: [{ googleSearch: {} }] },
  });

  const chunks =
    response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return {
    answer: (response.text || '').trim(),
    sources: chunks
      .map((chunk) => ({
        title: chunk.web?.title || '',
        url: chunk.web?.uri || '',
      }))
      .filter((source) => source.url)
      .slice(0, 5),
  };
}
