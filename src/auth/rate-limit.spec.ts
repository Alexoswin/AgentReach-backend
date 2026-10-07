import { HttpException, HttpStatus } from '@nestjs/common';
import { enforceAuthRateLimit, resetAuthRateLimits } from './rate-limit';

function requestFrom(ip: string) {
  return {
    headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` },
    socket: {},
  } as any;
}

describe('enforceAuthRateLimit', () => {
  beforeEach(() => resetAuthRateLimits());

  it('blocks repeated sign-in attempts against one email from any address', () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      enforceAuthRateLimit(
        'login',
        requestFrom(`203.0.113.${attempt}`),
        'Jane@x.com',
      );
    }

    let error: unknown;
    try {
      enforceAuthRateLimit('login', requestFrom('198.51.100.7'), 'jane@x.com');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );

    // Another account is unaffected.
    expect(() =>
      enforceAuthRateLimit('login', requestFrom('198.51.100.7'), 'other@x.com'),
    ).not.toThrow();
  });

  it('caps password-reset emails per address', () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      enforceAuthRateLimit(
        'forgot-password',
        requestFrom('203.0.113.1'),
        'a@x.com',
      );
    }
    expect(() =>
      enforceAuthRateLimit(
        'forgot-password',
        requestFrom('203.0.113.2'),
        'a@x.com',
      ),
    ).toThrow(HttpException);
  });
});
