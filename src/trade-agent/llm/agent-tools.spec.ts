import {
  MASTER_TOOLS,
  WORKER_OUTPUT_SCHEMA,
  metricsToRecord,
} from './agent-tools';

describe('agent tool surface', () => {
  describe('MASTER_TOOLS', () => {
    it('gives the model no way to reach the broker', () => {
      const names = MASTER_TOOLS.map((tool) => tool.name);

      // The whole design rests on this: the model proposes, it never places.
      expect(names).toEqual([
        'dispatch_worker',
        'request_market_data',
        'emit_order_intent',
        'finish',
      ]);
      expect(names).not.toContain('place_order');
      expect(names).not.toContain('cancel_order');
      expect(names).not.toContain('modify_order');
    });

    it('locks every tool schema down so malformed input never reaches our code', () => {
      for (const tool of MASTER_TOOLS) {
        const schema = tool.parametersJsonSchema as Record<string, any>;

        // `parameters` is Gemini's looser shorthand; we deliberately use the
        // JSON-schema form so these constraints are actually enforced.
        expect(tool.parameters).toBeUndefined();
        expect(schema).toBeDefined();
        expect(schema.type).toBe('object');
        expect(schema.additionalProperties).toBe(false);
        expect(Array.isArray(schema.required)).toBe(true);
        expect(tool.description?.length).toBeGreaterThan(20);
      }
    });

    it('constrains an order proposal to real broker enums', () => {
      const schema = MASTER_TOOLS.find(
        (tool) => tool.name === 'emit_order_intent',
      )!.parametersJsonSchema as Record<string, any>;

      expect(schema.properties.segment.enum).toEqual(['CASH', 'FNO']);
      expect(schema.properties.transactionType.enum).toEqual(['BUY', 'SELL']);
      expect(schema.properties.quantity).toMatchObject({
        type: 'integer',
        minimum: 1,
      });
      // A proposal a human cannot audit is a proposal they should decline.
      expect(schema.required).toContain('rationale');
    });
  });

  describe('WORKER_OUTPUT_SCHEMA', () => {
    it('requires a summary and a signal list', () => {
      expect(WORKER_OUTPUT_SCHEMA).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'signals'],
      });
    });

    it('models metrics as label/value pairs, not an open object', () => {
      const signal = (WORKER_OUTPUT_SCHEMA as any).properties.signals.items;

      // Gemini's JSON-schema support does not handle open-ended
      // `additionalProperties`, so the shape has to be fixed.
      expect(signal.properties.metrics.type).toBe('array');
      expect(signal.properties.metrics.items.additionalProperties).toBe(false);
      expect(signal.properties.metrics.items.required).toEqual([
        'label',
        'value',
      ]);
    });

    it('bounds confidence to 0-1', () => {
      const signal = (WORKER_OUTPUT_SCHEMA as any).properties.signals.items;
      expect(signal.properties.confidence).toMatchObject({
        type: 'number',
        minimum: 0,
        maximum: 1,
      });
    });
  });

  describe('metricsToRecord', () => {
    it('folds the label/value list back into a record', () => {
      expect(
        metricsToRecord([
          { label: 'RSI14', value: '71.2' },
          { label: 'ATR14', value: '28.4' },
        ]),
      ).toEqual({ RSI14: '71.2', ATR14: '28.4' });
    });

    it('stringifies a number or boolean a model returned off-schema', () => {
      expect(
        metricsToRecord([
          { label: 'rsi', value: 71.2 },
          { label: 'golden_cross', value: true },
        ]),
      ).toEqual({ rsi: '71.2', golden_cross: 'true' });
    });

    it('never produces "[object Object]"', () => {
      const result = metricsToRecord([
        { label: 'greeks', value: { delta: 0.5 } },
      ]);
      expect(result.greeks).toBe('{"delta":0.5}');
      expect(Object.values(result)).not.toContain('[object Object]');
    });

    it('drops entries without a usable label, and survives junk', () => {
      expect(
        metricsToRecord([{ value: 'orphan' }, { label: '', value: 'x' }]),
      ).toEqual({});
      expect(metricsToRecord(undefined)).toEqual({});
      expect(metricsToRecord('not an array')).toEqual({});
      expect(metricsToRecord([null, 42])).toEqual({});
    });
  });
});
