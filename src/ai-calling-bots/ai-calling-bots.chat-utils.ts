import { RetrievedKnowledge } from './ai-calling-bots.constants';
import {
  buildAgentPersona,
  buildChatPreUserPrompt as buildAgentChatPreUserPrompt,
  buildChatSystemPrompt,
  buildChatUserPrompt as buildAgentChatUserPrompt,
  buildFallbackChatReply as buildAgentFallbackChatReply,
  buildPromptSafeReply as buildAgentPromptSafeReply,
  buildRacContextFromResults as buildAgentRacContextFromResults,
  buildRacQuery as buildAgentRacQuery,
  compactSentence as compactSentenceBase,
  extractLastAssistantReply as extractLastAssistantReplyBase,
  extractRelevantKnowledgeSummary,
  finalizeReply,
  looksLikeInstructionEcho as looksLikeInstructionEchoBase,
  normalizeForComparison as normalizeForComparisonBase,
  parseJsonObjectLoose,
  sanitizeFallbackReply as sanitizeFallbackReplyBase,
  summarizeSnippet as summarizeSnippetBase,
} from '../ai-calling/ai-calling-agent';

type ChatBotPersona = {
  name: string;
  role: string;
  goal?: string;
  personality: string;
  knowledge?: string;
  language?: string;
  rules?: string;
  greeting?: string;
};

export function summarizeSnippet(value: string) {
  return summarizeSnippetBase(value);
}

export function compactSentence(value: string, maxLength = 240) {
  return compactSentenceBase(value, maxLength);
}

export function buildRacQuery(
  message: string,
  history: string,
  historyLineLimit: number,
) {
  return buildAgentRacQuery(message, history, historyLineLimit);
}

export function buildRacContextFromResults(
  results: RetrievedKnowledge[],
  topK: number,
) {
  return buildAgentRacContextFromResults(results, topK);
}

export function synthesizeBestAnswer(
  question: string,
  results: Array<{ content: string }>,
  botKnowledge: string,
) {
  const mergedKnowledge = [...results.map((item) => item.content), botKnowledge]
    .filter(Boolean)
    .join('\n');
  return compactSentenceBase(
    extractRelevantKnowledgeSummary(question, mergedKnowledge, 240, []),
    240,
  );
}

export function buildFallbackChatReply(
  message: string,
  bot: ChatBotPersona,
  results: RetrievedKnowledge[],
  racContext: string,
) {
  return buildAgentFallbackChatReply(
    message,
    buildAgentPersona({
      name: bot.name,
      role: bot.role,
      goal: bot.goal,
      personality: bot.personality,
      language: bot.language,
      knowledge: bot.knowledge,
      rules: bot.rules,
      greeting: bot.greeting,
    }),
    results,
    racContext,
  );
}

export function buildPromptSafeReply(bot: {
  name: string;
  role: string;
  personality: string;
}) {
  return buildAgentPromptSafeReply(bot);
}

export function normalizeForComparison(value: string) {
  return normalizeForComparisonBase(value);
}

export function extractLastAssistantReply(history: string) {
  return extractLastAssistantReplyBase(history);
}

export function looksLikeInstructionEcho(value: string) {
  return looksLikeInstructionEchoBase(value);
}

export function sanitizeFallbackReply(value: string) {
  return sanitizeFallbackReplyBase(value);
}

export function finalizeChatReply(
  llmReply: string,
  fallback: string,
  history: string,
) {
  return finalizeReply(llmReply, fallback, history);
}

export function getCoreSystemPromptForCallingBot(bot: ChatBotPersona) {
  return buildChatSystemPrompt(
    buildAgentPersona({
      name: bot.name,
      role: bot.role,
      goal: bot.goal,
      personality: bot.personality,
      language: bot.language,
      knowledge: bot.knowledge,
      rules: bot.rules,
      greeting: bot.greeting,
    }),
  );
}

export function buildChatPreUserPrompt(racContext: string) {
  return buildAgentChatPreUserPrompt(racContext);
}

export function buildChatUserPrompt(message: string, history: string) {
  return buildAgentChatUserPrompt(message, history);
}

export function parseJsonObject(content: string) {
  return parseJsonObjectLoose(content);
}
