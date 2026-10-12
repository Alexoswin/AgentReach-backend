import { readFileSync } from 'node:fs';
import { SMTPServer } from 'smtp-server';

const REPLY_DOMAIN = (process.env.REPLY_DOMAIN || '').trim().toLowerCase();
const API_INBOUND_URL = process.env.API_INBOUND_URL;
const INBOUND_SECRET = process.env.INBOUND_SECRET;
const MAX_BYTES = Number(process.env.MAX_MESSAGE_MB || 25) * 1024 * 1024;
const MAX_RECIPIENTS = 5;
const MAX_CONNECTIONS_PER_IP = 10;
const API_TIMEOUT_MS = 20000;
const REPLY_LOCAL_PART =
  /^reply\+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

if (!REPLY_DOMAIN || !API_INBOUND_URL || !INBOUND_SECRET) {
  throw new Error('REPLY_DOMAIN, API_INBOUND_URL and INBOUND_SECRET are required');
}

const tls = process.env.TLS_KEY_PATH && process.env.TLS_CERT_PATH;
const connections = new Map();

const smtpError = (responseCode, message) =>
  Object.assign(new Error(message), { responseCode });

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

const server = new SMTPServer({
  name: process.env.SMTP_HOSTNAME || undefined,
  banner: 'ReachConvert inbound',
  authOptional: true,
  disabledCommands: ['AUTH'],
  size: MAX_BYTES,
  hideSTARTTLS: !tls,
  key: tls ? readFileSync(process.env.TLS_KEY_PATH) : undefined,
  cert: tls ? readFileSync(process.env.TLS_CERT_PATH) : undefined,
  socketTimeout: 60000,

  onConnect(session, callback) {
    const count = (connections.get(session.remoteAddress) || 0) + 1;
    if (count > MAX_CONNECTIONS_PER_IP) {
      return callback(smtpError(421, 'Too many connections, try again later'));
    }
    connections.set(session.remoteAddress, count);
    callback();
  },

  onClose(session) {
    const count = (connections.get(session.remoteAddress) || 1) - 1;
    if (count > 0) connections.set(session.remoteAddress, count);
    else connections.delete(session.remoteAddress);
  },

  onRcptTo(address, session, callback) {
    const value = address.address.trim().toLowerCase();
    const at = value.lastIndexOf('@');
    if (
      at === -1 ||
      value.slice(at + 1) !== REPLY_DOMAIN ||
      !REPLY_LOCAL_PART.test(value.slice(0, at))
    ) {
      log('rejected', session.remoteAddress, value);
      return callback(smtpError(550, 'No such recipient'));
    }
    if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) {
      return callback(smtpError(452, 'Too many recipients'));
    }
    callback();
  },

  onData(stream, session, callback) {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BYTES) chunks.push(chunk);
    });
    stream.on('end', async () => {
      if (stream.sizeExceeded || size > MAX_BYTES) {
        return callback(smtpError(552, 'Message too large'));
      }

      const recipients = session.envelope.rcptTo.map((rcpt) => rcpt.address);
      try {
        const response = await fetch(API_INBOUND_URL, {
          method: 'POST',
          headers: {
            'content-type': 'message/rfc822',
            'x-inbound-secret': INBOUND_SECRET,
            'x-recipients': recipients.join(','),
          },
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        });
        if (response.ok) {
          log('accepted', session.remoteAddress, recipients.join(','), size);
          return callback(null, 'Accepted');
        }
        if (response.status === 400) {
          log('refused by api', recipients.join(','));
          return callback(smtpError(550, 'No such recipient'));
        }
        log('deferred', recipients.join(','), `api ${response.status}`);
      } catch (error) {
        log('deferred', recipients.join(','), error.message);
      }
      callback(smtpError(451, 'Temporary failure, try again later'));
    });
  },
});

server.on('error', (error) => log('error', error.message));
server.listen(Number(process.env.SMTP_PORT || 25), () =>
  log(`listening on ${process.env.SMTP_PORT || 25} for ${REPLY_DOMAIN}`),
);
