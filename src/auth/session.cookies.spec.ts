import { requiresCsrfToken } from './session.cookies';

describe('requiresCsrfToken', () => {
  it('lets Twilio and Plivo call their webhooks without a CSRF token', () => {
    for (const path of [
      '/api/calling-campaigns/plivo/answer/call-1',
      '/api/calling-campaigns/plivo/status/call-1',
      '/api/calling-campaigns/twilio/answer/call-1',
      '/api/calling-campaigns/twilio/status/call-1',
      '/api/calling-campaigns/twilio/recording/call-1',
    ]) {
      expect(requiresCsrfToken('POST', path)).toBe(false);
    }
  });

  it('still protects signed-in actions, including launching calls', () => {
    expect(
      requiresCsrfToken('POST', '/api/calling-campaigns/campaign-1/launch'),
    ).toBe(true);
    expect(requiresCsrfToken('PATCH', '/api/settings')).toBe(true);
    expect(requiresCsrfToken('POST', '/api/auth/logout')).toBe(true);
  });

  it('exempts reads and the sign-in routes', () => {
    expect(requiresCsrfToken('GET', '/api/settings')).toBe(false);
    expect(requiresCsrfToken('POST', '/api/auth/login')).toBe(false);
  });
});
