import { createSign, generateKeyPairSync } from 'crypto';
import { simpleParser } from 'mailparser';
import { buildForwardedEmail } from './forward-email';
import { addOpenPixel, parseTrackingToken } from './open-pixel';
import {
  campaignContactIdFromRecipients,
  isAutomatedMessage,
  stripQuotedReply,
} from './reply-parsing';
import { snsStringToSign, SnsMessage, verifySnsMessage } from './sns';

const ROW_ID = '3f2b8c1e-6a4d-4e9f-9b7a-0c1d2e3f4a5b';

describe('addOpenPixel', () => {
  const url = 'https://api.example.com/api/email-track/o/abc.gif';

  it('puts the image just before </body>', () => {
    const html = addOpenPixel('<html><BODY><p>Hi</p></BODY></html>', url);
    expect(html).toMatch(/<p>Hi<\/p><img src="[^"]+abc\.gif"[^>]*\/><\/BODY>/);
  });

  it('appends the image to HTML without a body tag', () => {
    expect(addOpenPixel('<p>Hi</p>', url)).toMatch(/^<p>Hi<\/p><img /);
  });
});

describe('parseTrackingToken', () => {
  it('accepts a token with or without the .gif suffix', () => {
    const token = 'a'.repeat(32);
    expect(parseTrackingToken(`${token}.gif`)).toBe(token);
    expect(parseTrackingToken(token.toUpperCase())).toBe(token);
  });

  it('rejects anything else before it reaches the database', () => {
    expect(parseTrackingToken('abc.gif')).toBeNull();
    expect(parseTrackingToken('{"$ne":null}')).toBeNull();
  });
});

describe('campaignContactIdFromRecipients', () => {
  it('finds the recipient row on the reply domain', () => {
    expect(
      campaignContactIdFromRecipients(
        ['someone@else.com', `Reply+${ROW_ID}@Reply.Example.com`],
        'reply.example.com',
      ),
    ).toBe(ROW_ID);
  });

  it('ignores the same address on another domain', () => {
    expect(
      campaignContactIdFromRecipients(
        [`reply+${ROW_ID}@evil.com`],
        'reply.example.com',
      ),
    ).toBeNull();
  });
});

describe('isAutomatedMessage', () => {
  it('flags autoresponders, bounces and out-of-office replies', () => {
    expect(
      isAutomatedMessage({ headers: { 'auto-submitted': 'auto-replied' } }),
    ).toBe(true);
    expect(
      isAutomatedMessage({
        headers: {
          'content-type': 'multipart/report; report-type=delivery-status',
        },
      }),
    ).toBe(true);
    expect(
      isAutomatedMessage({ headers: {}, fromAddress: 'MAILER-DAEMON@x.com' }),
    ).toBe(true);
    expect(
      isAutomatedMessage({
        headers: {},
        subject: 'Out of Office: back Monday',
      }),
    ).toBe(true);
  });

  it('lets a person-written reply through', () => {
    expect(
      isAutomatedMessage({
        headers: { 'auto-submitted': 'no' },
        subject: 'Re: Quick question',
        fromAddress: 'jane@acme.com',
      }),
    ).toBe(false);
  });
});

describe('stripQuotedReply', () => {
  it('drops the quoted original after a wrapped Gmail attribution', () => {
    const text =
      'Sounds good, call me Tuesday.\n\nOn Mon, 12 Oct 2026 at 10:00, Sam <sam@x.com>\nwrote:\n> Hi Jane';
    expect(stripQuotedReply(text)).toBe('Sounds good, call me Tuesday.');
  });

  it('drops an Outlook "From/Sent" block', () => {
    const text =
      'Not interested.\r\n\r\nFrom: Sam <sam@x.com>\r\nSent: Monday\r\nSubject: Hi';
    expect(stripQuotedReply(text)).toBe('Not interested.');
  });

  it('keeps the whole text when it is all quoted', () => {
    expect(stripQuotedReply('> only quoted')).toBe('> only quoted');
  });
});

describe('buildForwardedEmail', () => {
  it('re-addresses the reply and keeps body and threading headers', async () => {
    const raw = Buffer.from(
      [
        'Return-Path: <jane@acme.com>',
        'DKIM-Signature: v=1; a=rsa-sha256;',
        '\tb=abc',
        'From: Jane Doe <jane@acme.com>',
        `To: reply+${ROW_ID}@reply.example.com`,
        'Subject: Re: Hello',
        'In-Reply-To: <0100abc@email.amazonses.com>',
        'Message-ID: <original@acme.com>',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'Yes, let us talk. — Jané',
      ].join('\r\n'),
      'utf8',
    );

    const forwarded = buildForwardedEmail(raw, {
      fromAddress: 'notify@platform.com',
      fromName: 'Jane Doe',
      to: 'owner@user.com',
    });
    const parsed = await simpleParser(forwarded);

    expect(parsed.from?.value[0]).toEqual({
      address: 'notify@platform.com',
      name: 'Jane Doe via ReachConvert',
    });
    expect((parsed.replyTo as any).value[0].address).toBe('jane@acme.com');
    expect((parsed.to as any).value[0].address).toBe('owner@user.com');
    expect(parsed.inReplyTo).toBe('<0100abc@email.amazonses.com>');
    expect(parsed.messageId).not.toBe('<original@acme.com>');
    expect(parsed.headers.has('dkim-signature')).toBe(false);
    expect(parsed.text?.trim()).toBe('Yes, let us talk. — Jané');
  });
});

describe('verifySnsMessage', () => {
  const topicArn = 'arn:aws:sns:us-east-1:123456789012:replies';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  function signed(overrides: Partial<SnsMessage> = {}): SnsMessage {
    const message: SnsMessage = {
      Type: 'Notification',
      MessageId: 'm-1',
      TopicArn: topicArn,
      Message: '{"notificationType":"Received"}',
      Timestamp: '2026-10-12T10:00:00.000Z',
      SignatureVersion: '2',
      Signature: '',
      SigningCertURL:
        'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-1.pem',
      ...overrides,
    };
    message.Signature = createSign('RSA-SHA256')
      .update(snsStringToSign(message)!)
      .sign(privateKey, 'base64');
    return message;
  }

  beforeEach(() => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(publicPem as string));
  });
  afterEach(() => jest.restoreAllMocks());

  it('accepts a correctly signed message from an allowed topic', async () => {
    await expect(verifySnsMessage(signed(), [topicArn])).resolves.toBe(true);
  });

  it('rejects a tampered message', async () => {
    const message = { ...signed(), Message: '{"forged":true}' };
    await expect(verifySnsMessage(message, [topicArn])).resolves.toBe(false);
  });

  it('rejects a validly signed message from someone else’s topic', async () => {
    const message = signed({
      TopicArn: 'arn:aws:sns:us-east-1:999999999999:attacker',
    });
    await expect(verifySnsMessage(message, [topicArn])).resolves.toBe(false);
  });

  it('never fetches a certificate from a non-SNS host', async () => {
    const message = signed({
      SigningCertURL: 'https://attacker.example.com/cert.pem',
    });
    await expect(verifySnsMessage(message, [topicArn])).resolves.toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
