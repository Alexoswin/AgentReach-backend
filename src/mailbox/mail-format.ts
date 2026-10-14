import type { MailAddress } from '../schemas/mail-message.schema';

const SNIPPET_LENGTH = 160;

export function escapeHtml(value: string) {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

export function htmlToText(html: string) {
  return (html || '')
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|table)>/gi, '\n')
    .replace(
      /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href, label) => {
        const text = String(label)
          .replace(/<[^>]+>/g, '')
          .trim();
        return text && text !== href ? `${text} (${href})` : href;
      },
    )
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (match, name: string) => {
      if (ENTITIES[name] !== undefined) return ENTITIES[name];
      if (/^#\d+$/.test(name))
        return String.fromCodePoint(Number(name.slice(1)));
      return match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToHtml(text: string) {
  return (text || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
}

/** The inside of <body>, so a full HTML document can be nested in a quote. */
export function extractBody(html: string) {
  const match = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html || '');
  return (match ? match[1] : html || '')
    .replace(/<\/?(html|head|body)[^>]*>/gi, '')
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, '')
    .trim();
}

export function snippetOf(text: string, html = '') {
  const source = text?.trim() ? text : htmlToText(html);
  return source.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
}

export function formatAddressForDisplay(address?: MailAddress | null) {
  if (!address?.email) return '';
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

function formatQuoteDate(date: Date) {
  return date.toUTCString().replace('GMT', 'UTC');
}

/** The original message quoted under a reply, as Gmail and Outlook do. */
export function quoteForReply(source: {
  html?: string;
  text?: string;
  from?: MailAddress | null;
  date: Date;
}) {
  const attribution = `On ${formatQuoteDate(source.date)}, ${formatAddressForDisplay(source.from)} wrote:`;
  const body = source.html?.trim()
    ? extractBody(source.html)
    : textToHtml(source.text || '');
  const text = source.text?.trim()
    ? source.text
    : htmlToText(source.html || '');
  return {
    quotedHtml:
      `<div class="rc_quote"><div>${escapeHtml(attribution)}</div>` +
      `<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`,
    quotedText: `${attribution}\n${text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n')}`,
  };
}

/** The original message under a forward, with its headers on top. */
export function quoteForForward(source: {
  html?: string;
  text?: string;
  from?: MailAddress | null;
  to?: MailAddress[];
  subject?: string;
  date: Date;
}) {
  const lines = [
    '---------- Forwarded message ---------',
    `From: ${formatAddressForDisplay(source.from)}`,
    `Date: ${formatQuoteDate(source.date)}`,
    `Subject: ${source.subject || ''}`,
    `To: ${(source.to || []).map(formatAddressForDisplay).join(', ')}`,
  ];
  const body = source.html?.trim()
    ? extractBody(source.html)
    : textToHtml(source.text || '');
  const text = source.text?.trim()
    ? source.text
    : htmlToText(source.html || '');
  return {
    quotedHtml: `<div class="rc_quote"><div>${lines.map(escapeHtml).join('<br>')}</div><br>${body}</div>`,
    quotedText: `${lines.join('\n')}\n\n${text}`,
  };
}

export function withPrefix(prefix: 'Re' | 'Fwd', subject: string) {
  const clean = (subject || '').trim();
  const pattern = prefix === 'Re' ? /^re:/i : /^(fwd?|fw):/i;
  return pattern.test(clean) ? clean : `${prefix}: ${clean}`;
}
