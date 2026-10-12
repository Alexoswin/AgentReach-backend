import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { createGunzip } from 'zlib';

const USER_AGENT =
  'ReachConvertBot/1.0 (+https://www.reachconvert.site/compliance)';
const ROBOTS_AGENT = 'reachconvertbot';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const MIN_HOST_INTERVAL_MS = 1000;
const MAX_PAGES = 4;
const MAX_PAGE_CHARS = 5000;
const MAX_TOTAL_CHARS = 18_000;

export type RawResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

export type Transport = (url: URL) => Promise<RawResponse>;

export type SitePage = { url: string; text: string };

export type SiteContent = {
  pages: SitePage[];
  emails: string[];
  unreachableReason?: string;
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

const defaultTransport: Transport = (url) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
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
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
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

export function htmlToText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Math.min(Number(code), 0x10ffff)),
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
    try {
      found.push(decodeURIComponent(match[1]).trim().toLowerCase());
    } catch {
      found.push(match[1].trim().toLowerCase());
    }
  }
  return found;
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
  [/about|company|who-?we-?are|story/, 2],
  [/career|jobs|join|hiring|openings/, 2],
  [/contact/, 1],
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
    if (url.pathname === '/' || /\.(pdf|jpe?g|png|zip|docx?)$/i.test(url.pathname)) {
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

export class SiteReader {
  private readonly robots = new Map<string, RobotsRule[]>();
  private readonly lastRequestAt = new Map<string, number>();

  constructor(private readonly transport: Transport = defaultTransport) {}

  async readSite(domain: string): Promise<SiteContent> {
    for (const scheme of ['https', 'http']) {
      let home: URL;
      try {
        home = new URL(`${scheme}://${domain}/`);
        assertFetchable(home);
      } catch {
        return { pages: [], emails: [], unreachableReason: 'Blocked address' };
      }
      if (!(await this.robotsAllow(home))) {
        return {
          pages: [],
          emails: [],
          unreachableReason: 'Site disallows automated access',
        };
      }
      const page = await this.fetchPage(home).catch(() => null);
      if (!page) continue;
      return this.readRest(home, page);
    }
    return { pages: [], emails: [], unreachableReason: 'Website unreachable' };
  }

  private async readRest(
    home: URL,
    first: { url: URL; html: string },
  ): Promise<SiteContent> {
    const pages: SitePage[] = [];
    const emails = new Set<string>();
    const add = (page: { url: URL; html: string }) => {
      pages.push({
        url: page.url.toString(),
        text: htmlToText(page.html).slice(0, MAX_PAGE_CHARS),
      });
      extractMailtoEmails(page.html).forEach((email) => emails.add(email));
    };
    add(first);
    const targets = pickPages(extractLinks(first.html, first.url), home);
    let total = pages[0].text.length;
    for (const target of targets) {
      if (total >= MAX_TOTAL_CHARS) break;
      const url = new URL(target);
      if (!(await this.robotsAllow(url))) continue;
      const page = await this.fetchPage(url).catch(() => null);
      if (!page) continue;
      add(page);
      total += pages[pages.length - 1].text.length;
    }
    return { pages, emails: [...emails] };
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
      const { response } = await this.follow(new URL('/robots.txt', url.origin));
      if (response.status === 200) return parseRobots(response.body);
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
