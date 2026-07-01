import { Logger } from '@nestjs/common';
import { BotService } from '../bot/bot.service';
import { MongoService } from '../mongo.service';
import { ActiveCallSession } from './call-session.types';

// fetch_context must not stall the call: fall back to empty context after this.
// The agent is prompted to speak a short filler before calling the tool, but
// anything much beyond this still reads as dead air to the contact.
const FETCH_CONTEXT_TIMEOUT_MS = 2500;

export type CallToolsDeps = {
  logger: Logger;
  db: Pick<MongoService, 'callHistory'>;
  botService: Pick<BotService, 'searchBotKnowledge'>;
};

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export function buildCallTools(
  state: ActiveCallSession,
  deps: CallToolsDeps,
): {
  tools: Array<Record<string, unknown>>;
  handlers: Map<string, ToolHandler>;
} {
  const { logger, db, botService } = deps;
  const enabledTools = new Set<string>(
    Array.isArray(state.campaign?.tools)
      ? state.campaign.tools
      : ['end_call', 'fetch_context'],
  );
  const tools: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, ToolHandler>();

  if (enabledTools.has('end_call')) {
    tools.push({
      name: 'end_call',
      description:
        'Ends the call. Invoke only after the conversation objectives are complete and after delivering a closing statement.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: {
            type: 'STRING',
            description: 'Short reason for ending the call.',
          },
        },
        required: ['reason'],
      },
    });
    handlers.set('end_call', async (args) => {
      if (state.userTurns < 1) {
        return {
          status:
            'Call cannot be ended yet. Speak with the contact first, then continue toward the objective.',
        };
      }
      state.pendingHangup = true;
      state.endCallReason = String(args.reason || 'conversation_complete');
      await db.callHistory.update({
        where: { id: state.callId },
        data: { endCallReason: state.endCallReason },
      });
      return {
        status:
          'Call ending is scheduled after the final spoken audio finishes.',
      };
    });
  }

  if (enabledTools.has('fetch_context')) {
    tools.push({
      name: 'fetch_context',
      description:
        'Fetch relevant knowledge-base context for a specific user question.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'Standalone search query from the user question.',
          },
          bot_id: {
            type: 'STRING',
            description: 'Optional bot id. Use the configured bot id.',
          },
        },
        required: ['query'],
      },
    });
    handlers.set('fetch_context', async (args) => {
      const startedAt = Date.now();
      const query = String(args.query || '').trim();
      const botId =
        String(args.bot_id || '').trim() ||
        String(state.campaign.aiCallingBotId || '').trim();
      if (!query || !botId) {
        logger.debug(
          `Gemini Live fetch_context skipped callId=${state.callId} queryLength=${query.length} botId=${botId || 'none'} durationMs=${
            Date.now() - startedAt
          }`,
        );
        return { context: [], scores: [], sources: [], references: [] };
      }
      const results = await withTimeout(
        botService.searchBotKnowledge(botId, query, 4).catch((error: any) => {
          logger.warn(
            `Gemini Live fetch_context search failed callId=${state.callId}: ${error?.message || error}`,
          );
          return [] as Awaited<
            ReturnType<typeof botService.searchBotKnowledge>
          >;
        }),
        FETCH_CONTEXT_TIMEOUT_MS,
        [],
      );
      logger.debug(
        `Gemini Live fetch_context callId=${state.callId} botId=${botId} queryLength=${query.length} results=${results.length} durationMs=${
          Date.now() - startedAt
        }`,
      );
      return {
        context: results.map((item) => item.content),
        scores: results.map((item) => item.score),
        sources: results.map((item) => ({
          sourceName: item.metadata?.sourceName || 'knowledge-base',
          sourceType: item.metadata?.sourceType || 'document',
          score: item.score,
        })),
        references: results
          .map((item) => item.metadata?.ref || item.id)
          .filter(Boolean),
      };
    });
  }

  return { tools, handlers };
}

// Resolve to `fallback` if `promise` does not settle within `ms`, so a slow
// dependency (e.g. a knowledge-base query) can never stall the live call.
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
