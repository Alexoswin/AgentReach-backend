import { escapeHtml } from '../mailbox/mail-format';

export type UnsubscribeState = 'confirm' | 'done' | 'missing';

/** The small page behind the unsubscribe link in campaign emails. */
export function unsubscribePage(
  state: UnsubscribeState,
  target?: { email: string; sender: string } | null,
) {
  const email = escapeHtml(target?.email || '');
  const sender = escapeHtml(target?.sender || 'this sender');
  const content =
    state === 'missing'
      ? '<h1>Link not recognised</h1><p>This unsubscribe link is not valid any more.</p>'
      : state === 'done'
        ? `<h1>You're unsubscribed</h1><p><strong>${email}</strong> will not get more campaign emails from ${sender}.</p>`
        : `<h1>Unsubscribe?</h1><p>Stop campaign emails from ${sender} to <strong>${email}</strong>.</p>` +
          '<form method="post"><button type="submit">Unsubscribe</button></form>';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Unsubscribe</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827}main{max-width:420px;margin:16px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.08);text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.5;color:#4b5563;word-break:break-word}button{margin-top:12px;padding:12px 24px;border:0;border-radius:10px;background:#111827;color:#fff;font-size:15px;font-weight:600;cursor:pointer}</style></head><body><main>${content}</main></body></html>`;
}
