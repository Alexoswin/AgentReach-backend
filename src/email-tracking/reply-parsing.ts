const MAX_REPLY_TEXT_LENGTH = 5000;

// UUID of the MailThread (or, for emails sent before the mailbox existed,
// the EmailCampaignContact row), as put in Reply-To by
// EmailTrackingConfig.replyToAddress.
const REPLY_LOCAL_PART =
  /^reply\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The campaign recipient row a reply is addressed to, and the domain it was
 * sent to, from the envelope recipients SES received the message for. The
 * caller checks the domain against the row owner's reply domain.
 */
export function replyAddressFromRecipients(
  recipients: string[],
): { campaignContactId: string; domain: string } | null {
  for (const recipient of recipients || []) {
    const address = recipient.trim().toLowerCase();
    const at = address.lastIndexOf('@');
    if (at === -1) continue;
    const match = REPLY_LOCAL_PART.exec(address.slice(0, at));
    if (match) {
      return { campaignContactId: match[1], domain: address.slice(at + 1) };
    }
  }
  return null;
}

const AUTO_REPLY_SUBJECT =
  /^\s*(auto(matic)?[\s-]?(reply|response|antwort)|out of (the )?office|ooo\b|away from (the )?office|abwesenheit|absence|réponse automatique|respuesta automática|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|subsystem)|returned mail|failure notice)/i;

/**
 * Whether a message was sent by software rather than written by the contact:
 * out-of-office notices, autoresponders and bounces. These still reach the
 * user but must not count as replies.
 *
 * `headers` holds lower-cased header names.
 */
export function isAutomatedMessage({
  headers,
  subject,
  fromAddress,
}: {
  headers: Record<string, string>;
  subject?: string;
  fromAddress?: string;
}) {
  const autoSubmitted = headers['auto-submitted']?.trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;

  if (
    headers['x-autoreply'] ||
    headers['x-autorespond'] ||
    headers['x-autoresponder']
  ) {
    return true;
  }

  const precedence = headers['precedence']?.trim().toLowerCase();
  if (
    precedence &&
    ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)
  ) {
    return true;
  }

  if (/multipart\/report/i.test(headers['content-type'] || '')) return true;

  const localPart = (fromAddress || '').split('@')[0].toLowerCase();
  if (['mailer-daemon', 'postmaster'].includes(localPart)) return true;

  return AUTO_REPLY_SUBJECT.test(subject || '');
}

/**
 * The newly written part of a reply: the quoted original ("On … wrote:",
 * Outlook's "From:" block, "> " lines) is cut off. Falls back to the whole
 * text if that would leave nothing.
 */
export function stripQuotedReply(text: string) {
  const normalized = (text || '').replace(/\r\n/g, '\n');
  const markers = [
    // Gmail/Apple; the attribution line may wrap.
    /\n[ \t]*On [^\n]{0,200}(\n[^\n]{0,200})?wrote:[ \t]*\n/i,
    /\n[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/i,
    // Outlook: a "From:" line followed shortly by "Sent:" or "Date:".
    /\n[ \t]*_{5,}[ \t]*\n/,
    /\n[ \t]*From:[^\n]*\n[ \t]*(Sent|Date):/i,
    /\n>[^\n]*/,
  ];

  let cut = normalized.length;
  for (const marker of markers) {
    const match = marker.exec(`\n${normalized}`);
    if (match) cut = Math.min(cut, Math.max(0, match.index - 1));
  }

  const fresh = normalized.slice(0, cut).trim();
  return (fresh || normalized.trim()).slice(0, MAX_REPLY_TEXT_LENGTH);
}
