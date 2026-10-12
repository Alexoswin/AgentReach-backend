import {
  assertFetchable,
  htmlToText,
  isPrivateAddress,
  normalizeDomain,
  parseRobots,
  pickPages,
  RawResponse,
  robotsAllows,
  SiteReader,
  Transport,
} from './site-reader';

const page = (body: string, status = 200): RawResponse => ({
  status,
  headers: {},
  body,
});

describe('site-reader', () => {
  it('flags private, loopback and link-local addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:7f00:1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700::1111']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it('refuses unsafe URLs before any request is made', () => {
    for (const url of [
      'ftp://example.com/',
      'http://localhost/',
      'http://intranet/',
      'http://printer.local/',
      'http://127.0.0.1/',
      'http://[::1]/',
      'https://example.com:8443/',
      'https://user:pass@example.com/',
    ]) {
      expect(() => assertFetchable(new URL(url))).toThrow();
    }
    expect(() => assertFetchable(new URL('https://example.com/about'))).not.toThrow();
  });

  it('normalizes domains and rejects IPs', () => {
    expect(normalizeDomain('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(normalizeDomain('acme.co.in:8080')).toBe('acme.co.in');
    expect(normalizeDomain('10.0.0.1')).toBe('');
    expect(normalizeDomain('not a domain')).toBe('');
  });

  it('applies the most specific robots group and longest match', () => {
    const rules = parseRobots(
      [
        'User-agent: *',
        'Disallow: /private',
        '',
        'User-agent: ReachConvertBot',
        'Disallow: /team',
        'Allow: /team/public',
      ].join('\n'),
    );
    expect(robotsAllows(rules, '/about')).toBe(true);
    expect(robotsAllows(rules, '/private')).toBe(true);
    expect(robotsAllows(rules, '/team')).toBe(false);
    expect(robotsAllows(rules, '/team/public/x')).toBe(true);

    const wildcard = parseRobots('User-agent: *\nDisallow: /\n');
    expect(robotsAllows(wildcard, '/anything')).toBe(false);
    const pattern = parseRobots('User-agent: *\nDisallow: /*.pdf$\n');
    expect(robotsAllows(pattern, '/a/b.pdf')).toBe(false);
    expect(robotsAllows(pattern, '/a/b.pdf?x')).toBe(true);
  });

  it('turns html into text and drops scripts', () => {
    const text = htmlToText(
      '<h1>Our&nbsp;team</h1><script>alert(1)</script><p>Priya &amp; Rahul</p>',
    );
    expect(text).toContain('Our team');
    expect(text).toContain('Priya & Rahul');
    expect(text).not.toContain('alert');
  });

  it('picks team and careers pages on the same site only', () => {
    const home = new URL('https://acme.com/');
    const links = [
      { url: new URL('https://acme.com/about-us'), text: 'About' },
      { url: new URL('https://acme.com/leadership'), text: 'Leadership' },
      { url: new URL('https://acme.com/careers'), text: 'Jobs' },
      { url: new URL('https://other.com/team'), text: 'Team' },
      { url: new URL('https://acme.com/pricing'), text: 'Pricing' },
    ];
    const picked = pickPages(links, home);
    expect(picked[0]).toBe('https://acme.com/leadership');
    expect(picked).toContain('https://acme.com/about-us');
    expect(picked).toContain('https://acme.com/careers');
    expect(picked.some((url) => url.includes('other.com'))).toBe(false);
    expect(picked.some((url) => url.includes('pricing'))).toBe(false);
  });

  describe('SiteReader', () => {
    const makeReader = (routes: Record<string, RawResponse>) => {
      const transport: Transport = jest.fn(async (url) => {
        return routes[url.toString()] || page('', 404);
      });
      const reader = new SiteReader(transport);
      jest
        .spyOn(reader as any, 'throttle')
        .mockImplementation(async () => undefined);
      return { reader, transport };
    };

    it('reads the home page and linked team pages', async () => {
      const { reader } = makeReader({
        'https://acme.com/robots.txt': page('User-agent: *\nDisallow: /admin'),
        'https://acme.com/': page(
          '<a href="/team">Team</a><p>Welcome to Acme</p>',
        ),
        'https://acme.com/team': page(
          '<p>Priya Sharma</p><a href="mailto:priya@acme.com">mail</a>',
        ),
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages.map((item) => item.url)).toEqual([
        'https://acme.com/',
        'https://acme.com/team',
      ]);
      expect(site.emails).toEqual(['priya@acme.com']);
    });

    it('does not read a site that disallows crawling', async () => {
      const { reader, transport } = makeReader({
        'https://acme.com/robots.txt': page('User-agent: *\nDisallow: /'),
        'https://acme.com/': page('<p>hello</p>'),
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages).toEqual([]);
      expect(site.unreachableReason).toMatch(/disallows/);
      expect(transport).not.toHaveBeenCalledWith(
        new URL('https://acme.com/'),
      );
    });

    it('treats a failing robots.txt as disallowed and a missing one as allowed', async () => {
      const broken = makeReader({
        'https://acme.com/robots.txt': page('', 503),
        'https://acme.com/': page('<p>hello</p>'),
        'http://acme.com/robots.txt': page('', 503),
      });
      expect((await broken.reader.readSite('acme.com')).pages).toEqual([]);

      const missing = makeReader({
        'https://acme.com/': page('<p>hello world</p>'),
      });
      expect((await missing.reader.readSite('acme.com')).pages).toHaveLength(1);
    });

    it('follows a robots.txt redirect and re-checks redirected pages', async () => {
      const { reader } = makeReader({
        'https://acme.com/robots.txt': {
          status: 301,
          headers: { location: 'https://www.acme.com/robots.txt' },
          body: '',
        },
        'https://www.acme.com/robots.txt': page('User-agent: *\nDisallow: /secret'),
        'https://acme.com/': page('<p>hello</p>'),
      });
      expect((await reader.readSite('acme.com')).pages).toHaveLength(1);
    });

    it('blocks a redirect to a private address', async () => {
      const { reader } = makeReader({
        'https://acme.com/robots.txt': page(''),
        'https://acme.com/': {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
          body: '',
        },
        'http://acme.com/robots.txt': page(''),
        'http://acme.com/': {
          status: 302,
          headers: { location: 'http://127.0.0.1/' },
          body: '',
        },
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages).toEqual([]);
    });
  });
});
