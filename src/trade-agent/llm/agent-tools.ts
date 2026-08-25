import type { FunctionDeclaration } from '@google/genai';
import {
  GROWW_EXCHANGES,
  GROWW_ORDER_TYPES,
  GROWW_PRODUCTS,
  GROWW_SEGMENTS,
  GROWW_TRANSACTION_TYPES,
  GROWW_VALIDITIES,
} from '../../config/groww';
import { WORKER_IDS } from '../trade-agent.types';

/**
 * The master's tool surface.
 *
 * Note what is absent: there is no `place_order`, no `cancel_order`, no broker
 * write of any kind. The most the model can do is *propose* — `emit_order_intent`
 * writes a row that the validator, risk engine and (outside `auto` mode) a human
 * must all clear before anything reaches Groww.
 *
 * Declared with `parametersJsonSchema` rather than Gemini's `parameters`
 * shorthand, so `additionalProperties: false` and `required` are enforced by
 * the API and a malformed proposal never reaches our code.
 */
export const MASTER_TOOLS: FunctionDeclaration[] = [
  {
    name: 'dispatch_worker',
    description:
      'Run one specialist worker and receive its structured findings. Workers are ' +
      'read-only analysts: they cannot place orders. Dispatch several in one turn ' +
      'when their work is independent.',
    parametersJsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['worker', 'focus'],
      properties: {
        worker: {
          type: 'string',
          enum: [...WORKER_IDS],
          description: 'Which specialist to run.',
        },
        focus: {
          type: 'string',
          description:
            'What this worker should investigate on this cycle, in one or two sentences.',
        },
        symbols: {
          type: 'array',
          description:
            'Optional trading symbols to scope the worker to. Omit to let it choose.',
          items: { type: 'string' },
        },
      },
    },
  },
  {
    name: 'request_market_data',
    description:
      'Fetch live market data directly from the broker. Use for confirming a price ' +
      'before proposing an order.',
    parametersJsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'segment', 'symbols'],
      properties: {
        kind: { type: 'string', enum: ['ltp', 'ohlc', 'quote'] },
        segment: { type: 'string', enum: [...GROWW_SEGMENTS] },
        symbols: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['exchange', 'tradingSymbol'],
            properties: {
              exchange: { type: 'string', enum: [...GROWW_EXCHANGES] },
              tradingSymbol: { type: 'string' },
            },
          },
        },
      },
    },
  },
  {
    name: 'emit_order_intent',
    description:
      'Propose one order. This does NOT execute anything: the proposal is validated, ' +
      'risk-checked, and (unless the desk is in auto mode) approved by a human before ' +
      'it can reach the broker. Propose only what you would defend in writing.',
    parametersJsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'tradingSymbol',
        'exchange',
        'segment',
        'transactionType',
        'orderType',
        'product',
        'validity',
        'quantity',
        'rationale',
      ],
      properties: {
        tradingSymbol: {
          type: 'string',
          description:
            'Exact exchange trading symbol. Must match the instrument master verbatim.',
        },
        exchange: { type: 'string', enum: [...GROWW_EXCHANGES] },
        segment: { type: 'string', enum: [...GROWW_SEGMENTS] },
        transactionType: { type: 'string', enum: [...GROWW_TRANSACTION_TYPES] },
        orderType: { type: 'string', enum: [...GROWW_ORDER_TYPES] },
        product: { type: 'string', enum: [...GROWW_PRODUCTS] },
        validity: { type: 'string', enum: [...GROWW_VALIDITIES] },
        quantity: {
          type: 'integer',
          minimum: 1,
          description:
            'Whole units. For F&O this must be a multiple of the lot size.',
        },
        price: {
          type: 'number',
          description: 'Limit price. Required for LIMIT and SL orders.',
        },
        triggerPrice: {
          type: 'number',
          description: 'Trigger price. Required for SL and SL_M orders.',
        },
        rationale: {
          type: 'string',
          description:
            'Why this order, citing the worker findings that support it. A human reads this before approving.',
        },
        signalIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of the TradeSignals this proposal rests on.',
        },
      },
    },
  },
  {
    name: 'finish',
    description:
      'End the cycle. Call this once you have proposed everything you intend to, ' +
      'or concluded that no action is warranted — no action is a valid outcome.',
    parametersJsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description:
            'What you looked at, what you concluded, and why you proposed what you did.',
        },
      },
    },
  },
];

/**
 * Structured-output schema every worker returns. Prose is never accepted.
 *
 * `metrics` is a label/value list rather than a free-form object: Gemini's
 * JSON-schema support does not handle open-ended `additionalProperties` well,
 * and a fixed shape survives the round-trip intact. It is folded back into a
 * record when the signal is persisted.
 */
export const WORKER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'signals'],
  properties: {
    summary: {
      type: 'string',
      description: 'Two or three sentences on what you found this cycle.',
    },
    signals: {
      type: 'array',
      description:
        'Zero or more ideas. An empty list is a legitimate and common answer.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['tradingSymbol', 'direction', 'confidence', 'rationale'],
        properties: {
          tradingSymbol: { type: 'string' },
          exchange: { type: 'string', enum: [...GROWW_EXCHANGES] },
          segment: { type: 'string', enum: [...GROWW_SEGMENTS] },
          direction: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'AVOID'] },
          horizon: {
            type: 'string',
            enum: ['intraday', 'swing', 'positional', 'investment'],
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description:
              'Your own confidence. Never used as a risk input — the risk engine ignores it.',
          },
          rationale: { type: 'string' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'detail'],
              properties: {
                label: { type: 'string' },
                detail: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
          metrics: {
            type: 'array',
            description:
              'Numeric context worth keeping, e.g. RSI or IV, as label/value pairs.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'value'],
              properties: {
                label: { type: 'string' },
                value: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

/** Folds the schema's label/value list back into a plain record. */
export function metricsToRecord(metrics: unknown): Record<string, string> {
  if (!Array.isArray(metrics)) return {};

  return metrics.reduce<Record<string, string>>((acc, entry) => {
    const label = (entry as { label?: unknown })?.label;
    const value = (entry as { value?: unknown })?.value;
    if (typeof label !== 'string' || !label) return acc;

    // The schema types `value` as a string, but a model that returns a number
    // should not silently become "[object Object]" either.
    acc[label] =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value ?? null);

    return acc;
  }, {});
}
