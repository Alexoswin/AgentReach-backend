import { randomBytes } from 'crypto';
import { htmlToText } from './mail-format';

export type MimeAddress = { email: string; name?: string | null };

export type MimeAttachment = {
  name: string;
  contentType: string;
  content: Buffer;
  contentId?: string | null;
  inline?: boolean;
};

export type MimeMessage = {
  from: MimeAddress;
  to: MimeAddress[];
  cc?: MimeAddress[];
  replyTo?: string | null;
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string | null;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: MimeAttachment[];
  date?: Date;
};

type Part = { headers: string[]; body: string };

const CRLF = '\r\n';
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/**
 * Builds the raw message handed to SES SendRawEmail. Bcc is deliberately not
 * a header: those recipients only go in the envelope. SES replaces any
 * Message-ID set here with its own, but keeps In-Reply-To, References and
 * List-Unsubscribe.
 */
export function buildMimeMessage(message: MimeMessage): Buffer {
  const headers = [
    `From: ${formatAddress(message.from)}`,
    `To: ${message.to.map(formatAddress).join(', ')}`,
  ];
  if (message.cc?.length) {
    headers.push(`Cc: ${message.cc.map(formatAddress).join(', ')}`);
  }
  if (message.replyTo)
    headers.push(`Reply-To: ${headerValue(message.replyTo)}`);
  headers.push(`Subject: ${encodeHeaderWords(message.subject || '')}`);
  headers.push(`Date: ${(message.date || new Date()).toUTCString()}`);
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${headerValue(message.inReplyTo)}`);
  }
  if (message.references?.length) {
    headers.push(
      `References: ${message.references.map(headerValue).join(' ')}`,
    );
  }
  for (const [name, value] of Object.entries(message.headers || {})) {
    if (/^[A-Za-z0-9-]+$/.test(name))
      headers.push(`${name}: ${headerValue(value)}`);
  }
  headers.push('MIME-Version: 1.0');

  const root = buildBody(message);
  return Buffer.from(
    [...headers, ...root.headers, '', root.body].join(CRLF),
    'utf8',
  );
}

function buildBody(message: MimeMessage): Part {
  const html = message.html?.trim() ? message.html : '';
  const text = message.text?.trim()
    ? message.text
    : html
      ? htmlToText(html)
      : '';
  const attachments = message.attachments || [];
  const inline = html
    ? attachments.filter(
        (attachment) => attachment.inline && attachment.contentId,
      )
    : [];
  const regular = attachments.filter(
    (attachment) => !inline.includes(attachment),
  );

  const textParts: Part[] = [];
  if (text || !html) textParts.push(leaf('text/plain; charset=UTF-8', text));
  if (html) textParts.push(leaf('text/html; charset=UTF-8', html));

  let body =
    textParts.length > 1 ? multipart('alternative', textParts) : textParts[0];
  if (inline.length > 0) {
    body = multipart('related', [body, ...inline.map(attachmentPart)]);
  }
  if (regular.length > 0) {
    body = multipart('mixed', [body, ...regular.map(attachmentPart)]);
  }
  return body;
}

function leaf(
  contentType: string,
  content: string | Buffer,
  extra: string[] = [],
): Part {
  const data =
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return {
    headers: [
      `Content-Type: ${contentType}`,
      'Content-Transfer-Encoding: base64',
      ...extra,
    ],
    body: chunkBase64(data.toString('base64')),
  };
}

function multipart(subtype: string, parts: Part[]): Part {
  const boundary = `=_rc_${randomBytes(12).toString('hex')}`;
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${boundary}`, ...part.headers, '', part.body);
  }
  lines.push(`--${boundary}--`, '');
  return {
    headers: [`Content-Type: multipart/${subtype}; boundary="${boundary}"`],
    body: lines.join(CRLF),
  };
}

function attachmentPart(attachment: MimeAttachment): Part {
  const type = CONTENT_TYPE.test(attachment.contentType || '')
    ? attachment.contentType
    : 'application/octet-stream';
  const name = fileNameParameters(attachment.name);
  const extra = [
    `Content-Disposition: ${attachment.inline && attachment.contentId ? 'inline' : 'attachment'}; ${name.disposition}`,
  ];
  if (attachment.contentId) {
    extra.push(
      `Content-ID: <${headerValue(attachment.contentId).replace(/[<>]/g, '')}>`,
    );
  }
  return leaf(`${type}; ${name.type}`, attachment.content, extra);
}

function fileNameParameters(value: string) {
  const clean = (value || 'attachment')
    .replace(/[\r\n"\\]/g, '_')
    .slice(0, 180);
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return { type: `name="${clean}"`, disposition: `filename="${clean}"` };
  }
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return {
    type: `name="${encodeHeaderWords(clean)}"`,
    disposition: `filename="${ascii}"; filename*=UTF-8''${encoded}`,
  };
}

export function chunkBase64(value: string) {
  return (value.replace(/\s/g, '').match(/.{1,76}/g) || []).join(CRLF);
}

/** A header value with line breaks removed, so it cannot start a new header. */
export function headerValue(value: string) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** RFC 2047 encoded words for anything outside printable ASCII. */
export function encodeHeaderWords(value: string) {
  const clean = headerValue(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let current = '';
  for (const char of clean) {
    if (Buffer.byteLength(current + char, 'utf8') > 45) {
      words.push(current);
      current = '';
    }
    current += char;
  }
  if (current) words.push(current);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`,
    )
    .join(' ');
}

export function formatAddress(address: MimeAddress) {
  const email = headerValue(address.email).replace(/[<>\s,;]/g, '');
  const name = headerValue(address.name || '');
  if (!name) return `<${email}>`;
  if (/^[\x20-\x7e]*$/.test(name)) {
    return `"${name.replace(/["\\]/g, '\\$&')}" <${email}>`;
  }
  return `${encodeHeaderWords(name)} <${email}>`;
}

/** Rough size SES counts against its 10 MB raw message limit. */
export function encodedSize(parts: {
  html?: string;
  text?: string;
  attachmentBytes: number;
}) {
  const bodyBytes =
    Buffer.byteLength(parts.html || '', 'utf8') +
    Buffer.byteLength(parts.text || '', 'utf8');
  return Math.ceil(((bodyBytes + parts.attachmentBytes) * 4) / 3) + 4096;
}
