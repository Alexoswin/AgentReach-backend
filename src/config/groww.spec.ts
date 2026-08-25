import {
  exchangeSymbol,
  generateTotp,
  growwChecksum,
  nextTokenExpiry,
} from './groww';

describe('groww config helpers', () => {
  describe('nextTokenExpiry', () => {
    // Groww kills access tokens at 06:00 IST. IST is a fixed UTC+05:30 with no
    // DST, so 06:00 IST is always 00:30 UTC.
    const istOf = (date: Date) =>
      new Date(date.getTime() + 5.5 * 60 * 60 * 1000)
        .toISOString()
        .slice(11, 16);

    it.each([
      ['2026-08-20T00:00:00Z', '2026-08-20T00:30:00.000Z'], // 05:30 IST → today
      ['2026-08-20T01:00:00Z', '2026-08-21T00:30:00.000Z'], // 06:30 IST → tomorrow
      ['2026-08-20T12:00:00Z', '2026-08-21T00:30:00.000Z'], // 17:30 IST → tomorrow
      ['2026-08-20T23:00:00Z', '2026-08-21T00:30:00.000Z'], // 04:30 IST next day
    ])('resolves %s to %s', (from, expected) => {
      expect(nextTokenExpiry(new Date(from)).toISOString()).toBe(expected);
    });

    it('always lands on 06:00 IST, in the future, within 24 hours', () => {
      for (let hour = 0; hour < 24; hour++) {
        const from = new Date(Date.UTC(2026, 7, 20, hour, 17, 42));
        const expiry = nextTokenExpiry(from);

        expect(istOf(expiry)).toBe('06:00');
        expect(expiry.getTime()).toBeGreaterThan(from.getTime());
        expect(expiry.getTime() - from.getTime()).toBeLessThanOrEqual(
          24 * 60 * 60 * 1000,
        );
      }
    });

    it('crosses a month boundary correctly', () => {
      // 23:00 IST on the 31st → 06:00 IST on the 1st.
      const from = new Date('2026-08-31T17:30:00Z');
      expect(nextTokenExpiry(from).toISOString()).toBe(
        '2026-09-01T00:30:00.000Z',
      );
    });
  });

  describe('generateTotp', () => {
    // RFC 6238 SHA-1 vectors. The seed is the 20-byte ASCII string
    // "12345678901234567890", whose full base32 is 32 characters — the
    // frequently-quoted 16-character form is only the first 10 bytes.
    const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    it.each([
      [59_000, '287082'],
      [1_111_111_109_000, '081804'],
      [1_111_111_111_000, '050471'],
      [1_234_567_890_000, '005924'],
      [2_000_000_000_000, '279037'],
      // Counter exceeds 2^32 here, which exercises the 64-bit counter packing.
      [20_000_000_000_000, '353130'],
    ])('matches the RFC 6238 vector at t=%s', (atMs, expected) => {
      expect(generateTotp(SEED, atMs)).toBe(expected);
    });

    it('ignores padding, whitespace and case in the base32 secret', () => {
      const messy = ' gezdgnbvgy3tqojq gezdgnbvgy3tqojq ';
      expect(generateTotp(messy, 59_000)).toBe('287082');
    });

    it('rejects an empty secret rather than emitting a plausible code', () => {
      expect(() => generateTotp('', 59_000)).toThrow(/empty or not valid/i);
    });

    it('is stable inside a 30-second step and changes across one', () => {
      // 59s and 60s straddle the step boundary at 60s.
      expect(generateTotp(SEED, 59_000)).toBe(generateTotp(SEED, 45_000));
      expect(generateTotp(SEED, 59_000)).not.toBe(generateTotp(SEED, 60_000));
    });
  });

  describe('growwChecksum', () => {
    it('is SHA-256 over secret + epoch seconds', () => {
      const first = growwChecksum('secret', 1_719_830_400);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      // Deterministic for the same inputs, different across timestamps.
      expect(growwChecksum('secret', 1_719_830_400)).toBe(first);
      expect(growwChecksum('secret', 1_719_830_401)).not.toBe(first);
      expect(growwChecksum('other', 1_719_830_400)).not.toBe(first);
    });
  });

  describe('exchangeSymbol', () => {
    it('builds the LTP/OHLC key form', () => {
      expect(exchangeSymbol('NSE', 'RELIANCE')).toBe('NSE_RELIANCE');
    });
  });
});
