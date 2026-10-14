import { simpleParser } from 'mailparser';
import { buildMimeMessage, encodeHeaderWords, formatAddress } from './mime';
import {
  htmlToText,
  quoteForForward,
  quoteForReply,
  snippetOf,
  withPrefix,
} from './mail-format';
import { isRetryableSesError, sesMessageIdHeader } from './ses';

describe('buildMimeMessage', () => {
  it('round-trips headers, both bodies and an attachment', async () => {
    const raw = buildMimeMessage({
      from: { email: 'owner@acme.com', name: 'Owner Ü' },
      to: [{ email: 'jane@client.com', name: 'Jane "JJ" Doe' }],
      cc: [{ email: 'boss@client.com' }],
      replyTo: 'reply+abc@reply.acme.com',
      subject: 'Quarterly plan — ünïcode',
      html: '<p>Hello <b>Jane</b></p>',
      inReplyTo: '<prev@email.amazonses.com>',
      references: ['<first@x.com>', '<prev@email.amazonses.com>'],
      headers: {
        'List-Unsubscribe': '<https://api.acme.com/u/abc>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      attachments: [
        {
          name: 'plan.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('%PDF-1.4 test'),
        },
      ],
    });

    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe('Quarterly plan — ünïcode');
    expect(parsed.from?.value[0]).toMatchObject({
      address: 'owner@acme.com',
      name: 'Owner Ü',
    });
    expect((parsed.to as any).value[0]).toMatchObject({
      address: 'jane@client.com',
      name: 'Jane "JJ" Doe',
    });
    expect((parsed.cc as any).value[0].address).toBe('boss@client.com');
    expect(parsed.replyTo?.value[0].address).toBe('reply+abc@reply.acme.com');
    expect(parsed.inReplyTo).toBe('<prev@email.amazonses.com>');
    expect(parsed.references).toEqual([
      '<first@x.com>',
      '<prev@email.amazonses.com>',
    ]);
    const headerLine = (key: string) =>
      parsed.headerLines.find((line) => line.key === key)?.line;
    expect(headerLine('list-unsubscribe')).toBe(
      'List-Unsubscribe: <https://api.acme.com/u/abc>',
    );
    expect(headerLine('list-unsubscribe-post')).toBe(
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    );
    expect(parsed.html).toContain('<b>Jane</b>');
    // A text part is derived from the HTML for clients that want one.
    expect(parsed.text?.trim()).toBe('Hello Jane');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe('plan.pdf');
    expect(parsed.attachments[0].content.toString()).toBe('%PDF-1.4 test');
  });

  it('never writes a Bcc header and keeps line breaks out of headers', () => {
    const raw = buildMimeMessage({
      from: { email: 'owner@acme.com' },
      to: [{ email: 'jane@client.com' }],
      subject: 'Hi\r\nBcc: victim@evil.com',
      text: 'Body',
      headers: { 'X-Test': 'a\r\nInjected: yes' },
    }).toString();
    const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'));
    expect(headerBlock).not.toMatch(/^Bcc:/im);
    expect(headerBlock).not.toMatch(/^Injected:/im);
    expect(headerBlock).toContain('Subject: Hi Bcc: victim@evil.com');
  });

  it('keeps non-ASCII attachment names readable', async () => {
    const raw = buildMimeMessage({
      from: { email: 'owner@acme.com' },
      to: [{ email: 'jane@client.com' }],
      subject: 'Files',
      text: 'See attached',
      attachments: [
        {
          name: 'résumé.pdf',
          contentType: 'bad type\r\nX: y',
          content: Buffer.from('x'),
        },
      ],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.attachments[0].filename).toBe('résumé.pdf');
    // The made-up type is replaced, so it cannot inject a header.
    expect(raw.toString()).toContain('Content-Type: application/octet-stream;');
    expect(raw.toString()).not.toMatch(/^X: y/m);
  });

  it('encodes long non-ASCII headers as several words', () => {
    const encoded = encodeHeaderWords('ü'.repeat(60));
    expect(encoded.split(' ').length).toBeGreaterThan(1);
    expect(encodeHeaderWords('plain ascii')).toBe('plain ascii');
    expect(formatAddress({ email: 'a@b.com' })).toBe('<a@b.com>');
  });
});

describe('mail formatting', () => {
  it('turns HTML into readable text', () => {
    expect(
      htmlToText(
        '<style>p{}</style><p>Hi&nbsp;there</p><ul><li>One</li></ul><a href="https://x.com">site</a>',
      ),
    ).toBe('Hi there\n- One\nsite (https://x.com)');
  });

  it('quotes the original under a reply and a forward', () => {
    const source = {
      html: '<html><head><style>x</style></head><body><p>Original</p></body></html>',
      from: { email: 'jane@client.com', name: 'Jane' },
      to: [{ email: 'owner@acme.com' }],
      subject: 'Plan',
      date: new Date('2026-10-14T10:00:00Z'),
    };
    const reply = quoteForReply(source);
    expect(reply.quotedHtml).toContain('<blockquote');
    expect(reply.quotedHtml).toContain('<p>Original</p>');
    expect(reply.quotedHtml).not.toContain('<style>');
    expect(reply.quotedText).toContain('Jane <jane@client.com> wrote:');
    expect(reply.quotedText).toContain('> Original');

    const forward = quoteForForward(source);
    expect(forward.quotedText).toContain(
      '---------- Forwarded message ---------',
    );
    expect(forward.quotedText).toContain('Subject: Plan');
  });

  it('adds Re: and Fwd: once', () => {
    expect(withPrefix('Re', 'Plan')).toBe('Re: Plan');
    expect(withPrefix('Re', 'RE: Plan')).toBe('RE: Plan');
    expect(withPrefix('Fwd', 'Fw: Plan')).toBe('Fw: Plan');
  });

  it('makes a short one-line snippet', () => {
    expect(snippetOf('  Line one\n\nline two  ')).toBe('Line one line two');
    expect(snippetOf('', '<p>From html</p>')).toBe('From html');
    expect(snippetOf('x'.repeat(500)).length).toBe(160);
  });
});

describe('SES helpers', () => {
  it('predicts the Message-ID SES gives an email', () => {
    expect(sesMessageIdHeader('0100abc', 'us-east-1')).toBe(
      '<0100abc@email.amazonses.com>',
    );
    expect(sesMessageIdHeader('0100abc', 'eu-west-1')).toBe(
      '<0100abc@eu-west-1.amazonses.com>',
    );
  });

  it('retries throttling and outages but not rejections', () => {
    expect(
      isRetryableSesError({
        name: 'Throttling',
        message: 'Maximum sending rate exceeded.',
      }),
    ).toBe(true);
    expect(isRetryableSesError({ $metadata: { httpStatusCode: 503 } })).toBe(
      true,
    );
    expect(isRetryableSesError({ code: 'ECONNRESET' })).toBe(true);
    expect(
      isRetryableSesError({
        name: 'MessageRejected',
        message: 'Email address is not verified.',
      }),
    ).toBe(false);
    expect(
      isRetryableSesError({
        name: 'Throttling',
        message: 'Daily message quota exceeded.',
      }),
    ).toBe(false);
  });
});
