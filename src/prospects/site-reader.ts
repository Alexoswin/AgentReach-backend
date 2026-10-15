import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import type { CountryCode } from 'libphonenumber-js/max';
import { createGunzip } from 'zlib';
import {
  countryFromDomain,
  countryFromName,
  findPhones,
  parsePhone,
} from './phones';
import { extractEmails, linkedinUrl } from './verify';

const USER_AGENT =
  'ReachConvertBot/1.0 (+https://www.reachconvert.site/compliance)';
const ROBOTS_AGENT = 'reachconvertbot';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const MIN_HOST_INTERVAL_MS = 1000;
const MAX_PAGES = 5;
const MAX_PROFILE_PAGES = 3;
const MAX_PAGE_CHARS = 8000;
const MAX_PROFILE_CHARS = 3000;
const MAX_STRUCTURED_CHARS = 1500;
const MAX_TOTAL_CHARS = 40_000;
const MIN_PAGE_TEXT = 200;
const MAX_SITEMAP_URLS = 2000;
const MAX_CONTACTS = 30;
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const KEY_PAGES =
  /team|leadership|people|management|founders|executives|contact|reach-?us|get-?in-?touch/;
const TEAM_PAGES =
  /team|leadership|people|management|founders|executives|board|directors/;
const NOT_PROFILE =
  /career|job|culture|value|join|hiring|news|blog|contact|about|page|categor|tag|feed|event/;
const APP_SHELL =
  /<div[^>]*\bid\s*=\s*["'](?:root|app|__next|___gatsby|svelte)["'][^>]*>\s*<\/div>|<noscript[^>]*>[^<]{0,300}javascript/i;

export type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

export type Transport = (url: URL) => Promise<RawResponse>;

export type SitePage = { url: string; text: string };

export type SiteContact = {
  kind: 'email' | 'phone' | 'linkedin';
  value: string;
  url: string;
  label: string;
  type?: string;
  seen: string[];
};

export type SiteContent = {
  pages: SitePage[];
  emails: string[];
  contacts: SiteContact[];
  unreachableReason?: string;
};

type PageRead = {
  url: string;
  text: string;
  full: string;
  emails: string[];
  phones: Array<{ raw: string; label: string }>;
  links: string[];
  country?: CountryCode;
};

type RobotsRule = { allow: boolean; pattern: string };

export function normalizeDomain(input: unknown) {
  const text = typeof input === 'string' ? input.trim().toLowerCase() : '';
  const host = text
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return '';
  return net.isIP(host) ? '' : host;
}

function expandIpv6(address: string) {
  let value = address.toLowerCase().split('%')[0];
  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    value = value.replace(
      dotted[1],
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`,
    );
  }
  const [head, tail] = value.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts =
    tail === undefined
      ? headParts
      : [...headParts, ...Array(Math.max(missing, 0)).fill('0'), ...tailParts];
  return parts.map((part) => parseInt(part || '0', 16));
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (net.isIPv6(address)) {
    const hextets = expandIpv6(address);
    if (hextets.length !== 8 || hextets.some(Number.isNaN)) return true;
    if (hextets.every((part) => part === 0)) return true;
    if (hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1) {
      return true;
    }
    const mapped =
      hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff;
    if (mapped) {
      return isPrivateAddress(
        `${hextets[6] >> 8}.${hextets[6] & 255}.${hextets[7] >> 8}.${hextets[7] & 255}`,
      );
    }
    return (
      (hextets[0] & 0xfe00) === 0xfc00 ||
      (hextets[0] & 0xffc0) === 0xfe80 ||
      hextets[0] >> 8 === 0xff ||
      (hextets[0] === 0x2001 && hextets[1] === 0x0db8) ||
      hextets[0] === 0x64
    );
  }
  return true;
}

function safeLookup(hostname: string, options: any, callback: any) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = addresses as unknown as dns.LookupAddress[];
    if (!list.length || list.some((item) => isPrivateAddress(item.address))) {
      return callback(new Error('Blocked address'));
    }
    if (options?.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export function assertFetchable(url: URL) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https pages can be read');
  }
  if (url.username || url.password) throw new Error('Blocked address');
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('Blocked port');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Blocked address');
    return;
  }
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(local|internal|localhost|lan|home|corp)$/.test(host)
  ) {
    throw new Error('Blocked address');
  }
}

export const defaultTransport: Transport = (url) =>
  new Promise((resolveRaw, rejectRaw) => {
    const client = url.protocol === 'https:' ? https : http;
    const resolve = (value: RawResponse) => {
      clearTimeout(deadline);
      resolveRaw(value);
    };
    const reject = (error: Error) => {
      clearTimeout(deadline);
      rejectRaw(error);
    };
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Encoding': 'gzip',
        },
        lookup: safeLookup,
        timeout: REQUEST_TIMEOUT_MS,
      } as http.RequestOptions,
      (response) => {
        const type = String(response.headers['content-type'] || '');
        const readable =
          !type || /text\/|application\/(xhtml\+xml|xml)/i.test(type);
        const status = response.statusCode || 0;
        if (!readable || (status >= 300 && status < 400)) {
          response.resume();
          resolve({ status, headers: response.headers, body: '' });
          return;
        }
        const stream =
          response.headers['content-encoding'] === 'gzip'
            ? response.pipe(createGunzip())
            : response;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy();
            resolve({
              status,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
            return;
          }
          chunks.push(chunk);
        });
        stream.on('end', () =>
          resolve({
            status,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        stream.on('error', reject);
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error('Timed out')),
      REQUEST_TIMEOUT_MS,
    );
    request.on('timeout', () => request.destroy(new Error('Timed out')));
    request.on('error', reject);
    request.end();
  });

export function parseRobots(text: string): RobotsRule[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let collectingAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || !collectingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      collectingAgents = false;
      if (value)
        current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      collectingAgents = false;
    }
  }
  const specific = groups.filter((group) =>
    group.agents.some((agent) => agent !== '*' && ROBOTS_AGENT.includes(agent)),
  );
  const chosen = specific.length
    ? specific
    : groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

function patternToRegExp(pattern: string) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

export function robotsAllows(rules: RobotsRule[], path: string) {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    const length = rule.pattern.length;
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.allow)
    ) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

export function decodeEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Math.min(parseInt(code, 16), 0x10ffff)),
    )
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Math.min(Number(code), 0x10ffff)),
    );
}

export function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(
        /<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|br)>/gi,
        '\n',
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

export function extractMailtoEmails(html: string) {
  const found: string[] = [];
  const pattern = /href\s*=\s*["']mailto:([^"'?]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    found.push(safeDecode(decodeEntities(match[1])).trim().toLowerCase());
  }
  return found;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function decodeCloudflareEmail(hex: string) {
  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length < 2) return '';
  const email = Buffer.from(
    bytes.subarray(1).map((byte) => byte ^ bytes[0]),
  ).toString('utf8');
  return email.includes('@') ? email : '';
}

export function whatsappNumber(href: string) {
  try {
    const url = new URL(href);
    const host = url.hostname.replace(/^www\./, '');
    const number =
      host === 'wa.me'
        ? url.pathname.slice(1)
        : url.protocol === 'whatsapp:' || host.endsWith('whatsapp.com')
          ? url.searchParams.get('phone') || ''
          : '';
    const digits = number.replace(/[\s+().-]/g, '');
    return /^\d{7,15}$/.test(digits) ? digits : '';
  } catch {
    return '';
  }
}

function hiddenContact(href: string, inner: string) {
  const shown = () => htmlToText(inner).toLowerCase();
  if (/^mailto:/i.test(href)) {
    const email = safeDecode(href.slice(7).split('?')[0]).trim().toLowerCase();
    return email && !shown().includes(email) ? email : '';
  }
  if (/^(tel|callto):/i.test(href)) {
    const number = safeDecode(href.replace(/^(tel|callto):/i, '')).trim();
    const digits = number.replace(/\D/g, '');
    return digits.length >= 6 &&
      !shown().replace(/\D/g, '').includes(digits.slice(-6))
      ? number
      : '';
  }
  const whatsapp = whatsappNumber(href);
  if (whatsapp) {
    return shown().replace(/\D/g, '').includes(whatsapp.slice(-6))
      ? 'WhatsApp'
      : `WhatsApp +${whatsapp}`;
  }
  const profile = linkedinUrl(href);
  return profile?.kind === 'in' && !shown().includes('linkedin.com/in/')
    ? profile.url.replace('https://www.', '')
    : '';
}

export function revealContacts(html: string) {
  return html
    .replace(
      /(href\s*=\s*["'])[^"']*\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi,
      (_, start: string, hex: string) =>
        `${start}mailto:${decodeCloudflareEmail(hex)}`,
    )
    .replace(
      /<(a|span)\b[^>]*\bdata-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/\1>/gi,
      (_, _tag: string, hex: string) => decodeCloudflareEmail(hex),
    )
    .replace(
      /<a\s([^>]*?)href\s*=\s*(["'])([^"']*)\2([^>]*)>([\s\S]*?)<\/a>/gi,
      (
        whole: string,
        before: string,
        quote: string,
        href: string,
        after: string,
        inner: string,
      ) => {
        const target = decodeEntities(href).trim();
        if (
          !/^(mailto:|tel:|callto:|whatsapp:|(https?:)?\/\/([\w-]+\.)*(wa\.me|whatsapp\.com|linkedin\.com)\/)/i.test(
            target,
          )
        ) {
          return whole;
        }
        const extra = hiddenContact(target, inner);
        return extra
          ? `<a ${before}href=${quote}${href}${quote}${after}>${inner} ${extra}</a>`
          : whole;
      },
    );
}

export function revealObfuscatedEmails(text: string) {
  return text
    .replace(/(\w)\s*[[({<]\s*at\s*[\])}>]\s*(\w)/gi, '$1@$2')
    .replace(/(\w)\s*[[({<]\s*dot\s*[\])}>]\s*(\w)/gi, '$1.$2');
}

function strings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((item) =>
    typeof item === 'string' && item.trim() ? [item.trim()] : [],
  );
}

export function readStructuredData(html: string) {
  const result = {
    lines: [] as string[],
    emails: [] as string[],
    phones: [] as Array<{ raw: string; label: string }>,
    links: [] as string[],
    country: undefined as CountryCode | undefined,
  };
  let budget = 300;
  const visit = (node: unknown, depth: number, inherited: string) => {
    if (!node || typeof node !== 'object' || depth > 8 || budget-- <= 0) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1, inherited);
      return;
    }
    const item = node as Record<string, unknown>;
    const type = strings(item['@type']).join(' ');
    const person = /\bPerson\b/.test(type);
    const contactType = strings(item.contactType)[0]?.toLowerCase() || '';
    const label = person
      ? ''
      : contactType ||
        (/Organization|Business|Corporation|Store|Restaurant|Office/.test(type)
          ? 'main'
          : inherited);
    const emails = strings(item.email).map((email) =>
      email.replace(/^mailto:/i, '').toLowerCase(),
    );
    const phones = strings(item.telephone);
    const links = strings(item.sameAs).filter((url) => linkedinUrl(url));
    const name =
      typeof item.name === 'string'
        ? item.name.trim()
        : strings([item.givenName, item.familyName]).join(' ');
    result.emails.push(...emails);
    result.phones.push(...phones.map((raw) => ({ raw, label })));
    result.links.push(...links);
    if (
      person &&
      name &&
      (item.jobTitle || emails.length || phones.length || links.length)
    ) {
      result.lines.push(
        [
          name,
          ...strings(item.jobTitle),
          ...emails,
          ...phones,
          ...links.map((url) =>
            String(linkedinUrl(url)?.url).replace('https://www.', ''),
          ),
        ].join(', '),
      );
    } else if (!person && (emails.length || phones.length)) {
      result.lines.push(
        `${[name, contactType].filter(Boolean).join(', ') || 'Contact'}: ${[...emails, ...phones].join(', ')}`,
      );
    }
    const address = item.address as Record<string, unknown> | undefined;
    if (!result.country && address && typeof address === 'object') {
      const country = address.addressCountry as
        | Record<string, unknown>
        | string
        | undefined;
      result.country = countryFromName(
        country && typeof country === 'object' ? country.name : country,
      );
    }
    for (const [key, value] of Object.entries(item)) {
      if (key !== 'address') visit(value, depth + 1, label);
    }
  };
  for (const match of html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(
        JSON.parse(
          match[1]
            .trim()
            .replace(/^(<!--|<!\[CDATA\[)/, '')
            .replace(/(-->|\]\]>)$/, ''),
        ),
        0,
        '',
      );
    } catch {
      continue;
    }
  }
  result.lines = [...new Set(result.lines)];
  return result;
}

export function embeddedText(html: string) {
  const found = new Set<string>();
  const collect = (node: unknown, depth: number) => {
    if (found.size >= 2000 || depth > 40) return;
    if (typeof node === 'string') {
      const text = (/<[a-z][\s\S]*>/i.test(node) ? htmlToText(node) : node)
        .replace(/\s+/g, ' ')
        .trim();
      if (
        text.length > 1 &&
        text.length <= 2000 &&
        /\p{L}/u.test(text) &&
        !/^(https?:|\/|data:|#|\{|\[)/.test(text) &&
        !/^[\w.:-]{24,}$/.test(text)
      ) {
        found.add(text);
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) collect(value, depth + 1);
    }
  };
  for (const match of html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      collect(JSON.parse(match[1]), 0);
    } catch {
      continue;
    }
  }
  return [...found].join('\n').slice(0, MAX_PAGE_CHARS);
}

function stripChrome(html: string) {
  return html.replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
}

function readPage(url: URL, raw: string, secondary: boolean): PageRead {
  const html = revealContacts(raw);
  const structured = readStructuredData(html);
  const visible = htmlToText(html);
  const embedded = visible.length < MIN_PAGE_TEXT ? embeddedText(html) : '';
  const full = revealObfuscatedEmails(
    [visible, embedded].filter(Boolean).join('\n'),
  );
  const body = secondary
    ? revealObfuscatedEmails(
        [htmlToText(stripChrome(html)), embedded].filter(Boolean).join('\n'),
      )
    : full;
  const links = extractLinks(html, url).map((link) => link.url);
  return {
    url: url.toString(),
    text: [structured.lines.join('\n').slice(0, MAX_STRUCTURED_CHARS), body]
      .filter(Boolean)
      .join('\n'),
    full,
    emails: [
      ...extractMailtoEmails(html),
      ...extractEmails(full),
      ...structured.emails,
    ],
    phones: [
      ...structured.phones,
      ...links.flatMap((link) => {
        if (link.protocol === 'tel:' || link.protocol === 'callto:') {
          return [{ raw: safeDecode(link.pathname), label: '' }];
        }
        const whatsapp = whatsappNumber(link.toString());
        return whatsapp ? [{ raw: `+${whatsapp}`, label: 'whatsapp' }] : [];
      }),
    ],
    links: [...structured.links, ...links.map((link) => link.toString())],
    country: structured.country,
  };
}

function commonCountry(reads: PageRead[]) {
  const counts = new Map<CountryCode, number>();
  for (const read of reads) {
    const found = [
      ...read.phones.map((phone) => parsePhone(phone.raw)),
      ...findPhones(read.full),
    ];
    for (const phone of found) {
      if (phone?.country) {
        counts.set(phone.country, (counts.get(phone.country) || 0) + 1);
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function collectContacts(reads: PageRead[], host: string, hint?: CountryCode) {
  const country =
    reads.find((read) => read.country)?.country ||
    countryFromDomain(host) ||
    commonCountry(reads) ||
    hint;
  const found = new Map<string, SiteContact>();
  const note = (
    kind: SiteContact['kind'],
    value: string,
    url: string,
    label = '',
    type?: string,
  ) => {
    const key = `${kind}:${value}`;
    const entry = found.get(key) || {
      kind,
      value,
      url,
      label: '',
      ...(type ? { type } : {}),
      seen: [],
    };
    if (!entry.label && label) entry.label = label;
    if (!entry.seen.includes(url)) entry.seen.push(url);
    found.set(key, entry);
  };
  for (const read of reads) {
    for (const email of read.emails) {
      if (EMAIL.test(email)) note('email', email, read.url);
    }
    for (const phone of read.phones) {
      const parsed = parsePhone(phone.raw, country);
      if (parsed) {
        note('phone', parsed.number, read.url, phone.label, parsed.type);
      }
    }
    for (const phone of findPhones(read.full, country)) {
      note('phone', phone.number, read.url, '', phone.type);
    }
    for (const link of read.links) {
      const profile = linkedinUrl(link);
      if (profile) {
        note(
          'linkedin',
          profile.url,
          read.url,
          profile.kind === 'in' ? 'person' : 'company',
        );
      }
    }
  }
  const all = [...found.values()];
  return (['email', 'phone', 'linkedin'] as const).flatMap((kind) =>
    all.filter((item) => item.kind === kind).slice(0, MAX_CONTACTS),
  );
}

function sitemapUrls(xml: string) {
  return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map(
    (match) => decodeEntities(match[1]),
  );
}

export function extractLinks(html: string, base: URL) {
  const links: { url: URL; text: string }[] = [];
  const pattern = /<a\s[^>]*href\s*=\s*["']([^"'#]+)[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      const url = new URL(match[1], base);
      links.push({ url, text: htmlToText(match[2]).slice(0, 80) });
    } catch {
      continue;
    }
  }
  return links;
}

const PAGE_HINTS: Array<[RegExp, number]> = [
  [/team|leadership|people|management|founders|executives|our-?people/, 3],
  [/contact|reach-?us|get-?in-?touch|our-?offices|locations|branches/, 3],
  [/about|company|who-?we-?are|story/, 2],
  [/career|jobs|join|hiring|openings/, 2],
  [/news|press|media|blog/, 1],
];

export function pickPages(
  links: { url: URL; text: string }[],
  home: URL,
  limit = MAX_PAGES,
) {
  const hostOf = (url: URL) => url.hostname.replace(/^www\./, '');
  const scored = new Map<string, number>();
  for (const { url, text } of links) {
    if (!/^https?:$/.test(url.protocol) || hostOf(url) !== hostOf(home)) {
      continue;
    }
    const target = `${url.pathname} ${text}`.toLowerCase();
    if (
      url.pathname === '/' ||
      /\.(pdf|jpe?g|png|zip|docx?)$/i.test(url.pathname)
    ) {
      continue;
    }
    const score = PAGE_HINTS.reduce(
      (best, [pattern, weight]) =>
        pattern.test(target) ? Math.max(best, weight) : best,
      0,
    );
    if (score > 0) {
      url.hash = '';
      const key = url.toString();
      scored.set(key, Math.max(scored.get(key) || 0, score));
    }
  }
  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}

export function pickProfiles(
  links: { url: URL; text: string }[],
  page: URL,
  limit = MAX_PROFILE_PAGES,
) {
  const base = page.pathname.replace(/\/+$/, '');
  const host = page.hostname.replace(/^www\./, '');
  const found: string[] = [];
  for (const { url, text } of links) {
    if (!base || url.hostname.replace(/^www\./, '') !== host) continue;
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith(`${base}/`)) continue;
    const slug = safeDecode(path.slice(base.length + 1)).toLowerCase();
    if (
      !/^[\p{L}\p{N}]+([-_][\p{L}\p{N}]+)*$/u.test(slug) ||
      NOT_PROFILE.test(slug) ||
      (!/[-_]/.test(slug) && !/profile|bio|more|view/i.test(text))
    ) {
      continue;
    }
    const target = `${url.origin}${url.pathname}`;
    if (!found.includes(target)) found.push(target);
  }
  return found.slice(0, limit);
}

export class SiteReader {
  private readonly robots = new Map<string, RobotsRule[]>();
  private readonly sitemaps = new Map<string, string[]>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(private readonly transport: Transport = defaultTransport) {}

  async readSite(
    domain: string,
    options: { country?: CountryCode } = {},
  ): Promise<SiteContent> {
    for (const scheme of ['https', 'http']) {
      let home: URL;
      try {
        home = new URL(`${scheme}://${domain}/`);
        assertFetchable(home);
      } catch {
        return {
          pages: [],
          emails: [],
          contacts: [],
          unreachableReason: 'Blocked address',
        };
      }
      if (!(await this.robotsAllow(home))) {
        return {
          pages: [],
          emails: [],
          contacts: [],
          unreachableReason: 'Site disallows automated access',
        };
      }
      const page = await this.fetchPage(home).catch(() => null);
      if (!page) continue;
      return this.readRest(home, page, options.country);
    }
    return {
      pages: [],
      emails: [],
      contacts: [],
      unreachableReason: 'Website unreachable',
    };
  }

  private async readRest(
    home: URL,
    first: { url: URL; html: string },
    country?: CountryCode,
  ): Promise<SiteContent> {
    const pages: SitePage[] = [];
    const reads: PageRead[] = [];
    const add = (page: { url: URL; html: string }, limit: number) => {
      const read = readPage(page.url, page.html, pages.length > 0);
      reads.push(read);
      pages.push({ url: read.url, text: read.text.slice(0, limit) });
    };
    add(first, MAX_PAGE_CHARS);
    const links = extractLinks(first.html, first.url);
    let targets = pickPages(links, home);
    const keyPages = targets.filter((target) =>
      KEY_PAGES.test(new URL(target).pathname.toLowerCase()),
    );
    if (keyPages.length < 2) {
      targets = pickPages([...links, ...(await this.sitemapLinks(home))], home);
    }
    let total = pages[0].text.length;
    const visit = async (target: string, limit: number) => {
      if (
        total >= MAX_TOTAL_CHARS ||
        pages.some((page) => page.url === target)
      ) {
        return null;
      }
      const url = new URL(target);
      if (!(await this.robotsAllow(url))) return null;
      const page = await this.fetchPage(url).catch(() => null);
      if (!page || pages.some((item) => item.url === page.url.toString())) {
        return null;
      }
      add(page, limit);
      total += pages[pages.length - 1].text.length;
      return page;
    };
    const profiles: string[] = [];
    for (const target of targets) {
      const page = await visit(target, MAX_PAGE_CHARS);
      if (page && TEAM_PAGES.test(page.url.pathname.toLowerCase())) {
        profiles.push(
          ...pickProfiles(extractLinks(page.html, page.url), page.url),
        );
      }
    }
    for (const target of [...new Set(profiles)].slice(0, MAX_PROFILE_PAGES)) {
      await visit(target, MAX_PROFILE_CHARS);
    }
    const length = pages.reduce((sum, page) => sum + page.text.length, 0);
    if (length < MIN_PAGE_TEXT && APP_SHELL.test(first.html)) {
      return {
        pages: [],
        emails: [],
        contacts: [],
        unreachableReason: 'The website needs JavaScript to show its content',
      };
    }
    const contacts = collectContacts(reads, home.hostname, country);
    return {
      pages,
      emails: contacts
        .filter((item) => item.kind === 'email')
        .map((item) => item.value),
      contacts,
    };
  }

  private async sitemapLinks(home: URL) {
    const listed = this.sitemaps.get(home.origin) || [];
    const candidates = [
      ...new Set([...listed, new URL('/sitemap.xml', home.origin).toString()]),
    ].slice(0, 2);
    for (const candidate of candidates) {
      let xml = await this.fetchText(candidate);
      if (!xml) continue;
      if (/<sitemapindex/i.test(xml)) {
        const children = sitemapUrls(xml);
        const child =
          children.find((url) => /page/i.test(url)) || children[0];
        xml = child ? await this.fetchText(child) : '';
      }
      return sitemapUrls(xml)
        .slice(0, MAX_SITEMAP_URLS)
        .flatMap((loc) => {
          try {
            return [{ url: new URL(loc), text: '' }];
          } catch {
            return [];
          }
        });
    }
    return [];
  }

  private async fetchText(target: string) {
    try {
      const url = new URL(target);
      if (!(await this.robotsAllow(url))) return '';
      return (await this.fetchPage(url)).html;
    } catch {
      return '';
    }
  }

  private async follow(start: URL, allowed?: (url: URL) => Promise<boolean>) {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertFetchable(url);
      await this.throttle(url.hostname);
      const response = await this.transport(url);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.location;
        if (!location) throw new Error('Bad redirect');
        url = new URL(location, url);
        if (allowed && !(await allowed(url))) throw new Error('Disallowed');
        continue;
      }
      return { url, response };
    }
    throw new Error('Too many redirects');
  }

  private async fetchPage(start: URL) {
    const { url, response } = await this.follow(start, (target) =>
      this.robotsAllow(target),
    );
    if (response.status !== 200 || !response.body) {
      throw new Error(`Status ${response.status}`);
    }
    return { url, html: response.body };
  }

  private async robotsAllow(url: URL) {
    let rules = this.robots.get(url.origin);
    if (!rules) {
      rules = await this.loadRobots(url);
      this.robots.set(url.origin, rules);
    }
    return robotsAllows(rules, `${url.pathname}${url.search}`);
  }

  private async loadRobots(url: URL): Promise<RobotsRule[]> {
    try {
      const { response } = await this.follow(
        new URL('/robots.txt', url.origin),
      );
      if (response.status === 200) {
        this.sitemaps.set(
          url.origin,
          [...response.body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(
            (match) => match[1],
          ),
        );
        return parseRobots(response.body);
      }
      if (response.status >= 400 && response.status < 500) return [];
    } catch {
      return [{ allow: false, pattern: '/' }];
    }
    return [{ allow: false, pattern: '/' }];
  }

  private async throttle(host: string) {
    const wait =
      (this.lastRequestAt.get(host) || 0) + MIN_HOST_INTERVAL_MS - Date.now();
    this.lastRequestAt.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
