import { randomBytes } from 'crypto';

/** 1×1 transparent GIF returned by the open-tracking endpoint. */
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const TRACKING_TOKEN_PATTERN = /^[a-f0-9]{32}$/;

export function newTrackingToken() {
  return randomBytes(16).toString('hex');
}

/** Accepts the token with or without the `.gif` suffix from the URL. */
export function parseTrackingToken(value: string): string | null {
  const token = (value || '').replace(/\.gif$/i, '').toLowerCase();
  return TRACKING_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Adds the tracking image to the HTML that goes to SES. The stored copy of
 * the email must stay without it: the app shows sent emails, and rendering
 * one there would load the image and count the sender's own view as an open.
 */
export function addOpenPixel(html: string, pixelUrl: string) {
  const img = `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  return bodyClose === -1
    ? `${html}${img}`
    : `${html.slice(0, bodyClose)}${img}${html.slice(bodyClose)}`;
}
