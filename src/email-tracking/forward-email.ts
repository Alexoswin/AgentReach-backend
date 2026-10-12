// Headers that identify the original sender's mail server or would make SES
// reject the message (it only sends From addresses it has verified).
const DROPPED_HEADERS = new Set([
  'return-path',
  'sender',
  'message-id',
  'dkim-signature',
  'from',
  'reply-to',
  'to',
  'cc',
  'bcc',
]);

function encodeMimeWord(value: string) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Re-addresses a received reply so the platform SES identity can pass it on
 * to the user. The body, attachments and threading headers (In-Reply-To,
 * References) are kept byte for byte; From becomes "<name> via ReachConvert"
 * on the platform address and Reply-To points back at the person who wrote,
 * so the user can answer them directly.
 *
 * The message is handled as latin1 so 8-bit bodies survive unchanged.
 */
export function buildForwardedEmail(
  raw: Buffer,
  {
    fromAddress,
    fromName,
    to,
  }: { fromAddress: string; fromName?: string; to: string },
) {
  const message = raw.toString('latin1');
  const separator = /\r?\n\r?\n/.exec(message);
  const headerBlock = separator ? message.slice(0, separator.index) : message;
  const rest = separator ? message.slice(separator.index) : '\r\n\r\n';

  const fields: string[] = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && fields.length > 0) {
      fields[fields.length - 1] += `\r\n${line}`;
    } else if (line) {
      fields.push(line);
    }
  }

  let originalFrom = '';
  const kept = fields.filter((field) => {
    const name = field.slice(0, field.indexOf(':')).trim().toLowerCase();
    if (name === 'from') {
      originalFrom = field
        .slice(field.indexOf(':') + 1)
        .replace(/\r\n[ \t]+/g, ' ')
        .trim();
    }
    return !DROPPED_HEADERS.has(name);
  });

  const displayName = `${fromName || originalFrom || 'Reply'} via ReachConvert`;
  const header = [
    `From: ${encodeMimeWord(displayName)} <${fromAddress}>`,
    ...(originalFrom ? [`Reply-To: ${originalFrom}`] : []),
    `To: <${to}>`,
    ...kept,
  ].join('\r\n');

  return Buffer.from(header + rest, 'latin1');
}
