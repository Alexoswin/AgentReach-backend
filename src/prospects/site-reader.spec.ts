import * as http from 'http';
import {
  assertFetchable,
  defaultTransport,
  embeddedText,
  extractMailtoEmails,
  htmlToText,
  isPrivateAddress,
  normalizeDomain,
  parseRobots,
  pickPages,
  pickProfiles,
  RawResponse,
  readStructuredData,
  revealContacts,
  revealObfuscatedEmails,
  robotsAllows,
  SiteReader,
  Transport,
} from './site-reader';

const cloudflare = (email: string, key = 0x42) =>
  key.toString(16).padStart(2, '0') +
  [...email]
    .map((char) => (char.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
    .join('');

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
    expect(() =>
      assertFetchable(new URL('https://example.com/about')),
    ).not.toThrow();
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

  it('shows hidden email, phone, WhatsApp and LinkedIn links in the text', () => {
    const html = [
      `<p>Priya Sharma <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${cloudflare('priya.sharma@acme.com')}">[email&#160;protected]</a></p>`,
      `<p><a href="/cdn-cgi/l/email-protection#${cloudflare('hello@acme.com')}">Write to us</a></p>`,
      '<p><a href="tel:+912040123456">Call us</a></p>',
      '<p><a href="https://wa.me/919988776655">Chat</a></p>',
      '<p><a href="https://in.linkedin.com/in/Priya-Sharma/"><svg></svg></a></p>',
      '<p><a href="mailto:rahul@acme.com">rahul@acme.com</a></p>',
    ].join('');
    const text = htmlToText(revealContacts(html));
    expect(text).toContain('Priya Sharma priya.sharma@acme.com');
    expect(text).toContain('Write to us hello@acme.com');
    expect(text).toContain('Call us +912040123456');
    expect(text).toContain('Chat WhatsApp +919988776655');
    expect(text).toContain('linkedin.com/in/priya-sharma');
    expect(text.match(/rahul@acme\.com/g)).toHaveLength(1);
  });

  it('decodes encoded and bracketed email addresses', () => {
    expect(
      htmlToText('<p>priya&#x40;acme&#46;com or rahul&commat;acme.com</p>'),
    ).toBe('priya@acme.com or rahul@acme.com');
    expect(
      revealObfuscatedEmails(
        'priya.sharma [at] acme [dot] com, info(at)acme(dot)co(dot)in',
      ),
    ).toBe('priya.sharma@acme.com, info@acme.co.in');
    expect(
      extractMailtoEmails('<a href="mailto:&#112;riya@acme.com">x</a>'),
    ).toEqual(['priya@acme.com']);
  });

  it('reads contact details and people from structured data', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          name: 'Acme',
          email: 'mailto:Sales@acme.com',
          telephone: '+91 20 4012 3456',
          address: { '@type': 'PostalAddress', addressCountry: 'IN' },
          sameAs: [
            'https://www.linkedin.com/company/acme',
            'https://twitter.com/acme',
          ],
          contactPoint: [
            {
              '@type': 'ContactPoint',
              contactType: 'Customer Support',
              telephone: '1800-123-4567',
            },
          ],
          employee: [
            {
              '@type': 'Person',
              name: 'Priya Sharma',
              jobTitle: 'VP HR',
              telephone: '+91 91234 56789',
              sameAs: 'https://linkedin.com/in/priya-sharma',
            },
          ],
        },
      ],
    };
    const data = readStructuredData(
      `<script type="application/ld+json">${JSON.stringify(graph)}</script>` +
        '<script type="application/ld+json">{ not json</script>',
    );
    expect(data.country).toBe('IN');
    expect(data.emails).toEqual(['sales@acme.com']);
    expect(data.phones).toEqual([
      { raw: '+91 20 4012 3456', label: 'main' },
      { raw: '1800-123-4567', label: 'customer support' },
      { raw: '+91 91234 56789', label: '' },
    ]);
    expect(data.links).toEqual([
      'https://www.linkedin.com/company/acme',
      'https://linkedin.com/in/priya-sharma',
    ]);
    expect(data.lines).toEqual([
      'Acme: sales@acme.com, +91 20 4012 3456',
      'customer support: 1800-123-4567',
      'Priya Sharma, VP HR, +91 91234 56789, linkedin.com/in/priya-sharma',
    ]);
  });

  it('reads the text a JavaScript site embeds as data', () => {
    const data = {
      props: {
        pageProps: {
          team: [
            {
              name: 'Priya Sharma',
              role: 'VP HR',
              bio: '<p>Leads people at Acme</p>',
            },
          ],
        },
        buildId: 'abcdefghijklmnopqrstuvwxyz123',
      },
      page: '/team',
    };
    const html = `<div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
    expect(embeddedText(html).split('\n')).toEqual([
      'Priya Sharma',
      'VP HR',
      'Leads people at Acme',
    ]);
  });

  it('picks profile pages linked from a team page', () => {
    const team = new URL('https://acme.com/team/');
    const links = [
      ['https://acme.com/team/priya-sharma', 'Priya Sharma'],
      ['https://acme.com/team/rahul', 'Rahul Iyer'],
      ['https://acme.com/team/nina', 'View profile'],
      ['https://acme.com/team/careers', 'Join us'],
      ['https://acme.com/team/our-culture', 'Culture'],
      ['https://acme.com/team/priya-sharma/', 'Priya'],
      ['https://other.com/team/someone-else', 'Someone'],
      ['https://acme.com/about/kiran-rao', 'Kiran Rao'],
    ].map(([url, text]) => ({ url: new URL(url), text }));
    expect(pickProfiles(links, team)).toEqual([
      'https://acme.com/team/priya-sharma',
      'https://acme.com/team/nina',
    ]);
  });

  it('refuses to connect when a hostname resolves to a private address', async () => {
    const server = http.createServer((_, res) => res.end('secret'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      await expect(
        defaultTransport(new URL(`http://localhost:${port}/`)),
      ).rejects.toThrow(/Blocked address/);
    } finally {
      server.close();
    }
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

    it('collects contacts from every page, past the text limit too', async () => {
      const filler = `<p>${'We build software for banks. '.repeat(400)}</p>`;
      const footer =
        '<footer>Call +91 20 4012 3456 · <a href="mailto:hello@acme.com">Email</a> · <a href="https://www.linkedin.com/company/acme">LinkedIn</a></footer>';
      const { reader } = makeReader({
        'https://acme.com/': page(
          `<nav><a href="/team">Team</a><a href="/contact-us">Contact</a><a href="/blog">Blog</a></nav>${filler}${footer}`,
        ),
        'https://acme.com/team': page(
          `<nav>Main menu</nav><h3>Priya Sharma</h3><p>VP HR</p><a href="tel:+919123456789">Call</a> <a href="https://linkedin.com/in/priya-sharma">in</a>${footer}`,
        ),
        'https://acme.com/contact-us': page(
          `<p>Sales: <a href="mailto:sales@acme.com">sales@acme.com</a></p><a href="https://wa.me/919988776655">WhatsApp us</a>${footer}`,
        ),
      });
      const site = await reader.readSite('acme.com');

      expect(site.pages.map((item) => item.url)).toEqual([
        'https://acme.com/',
        'https://acme.com/team',
        'https://acme.com/contact-us',
      ]);
      expect(site.pages[0].text).not.toContain('4012');
      expect(site.pages[1].text).toContain(
        'Priya Sharma\nVP HR\nCall +919123456789 in linkedin.com/in/priya-sharma',
      );
      expect(site.pages[1].text).not.toMatch(/Main menu|4012/);
      expect(site.emails.sort()).toEqual(['hello@acme.com', 'sales@acme.com']);

      const byValue = Object.fromEntries(
        site.contacts.map((item) => [item.value, item]),
      );
      expect(byValue['+912040123456']).toMatchObject({
        kind: 'phone',
        type: 'landline',
        seen: [
          'https://acme.com/',
          'https://acme.com/team',
          'https://acme.com/contact-us',
        ],
      });
      expect(byValue['+919123456789']).toMatchObject({
        type: 'mobile',
        url: 'https://acme.com/team',
      });
      expect(byValue['+919988776655']).toMatchObject({ label: 'whatsapp' });
      expect(byValue['https://www.linkedin.com/in/priya-sharma'].label).toBe(
        'person',
      );
      expect(byValue['https://www.linkedin.com/company/acme'].label).toBe(
        'company',
      );
    });

    it('reads national numbers only when the country is known', async () => {
      const html = page('<p>Call us on 020 4012 3456</p>');
      const indian = makeReader({ 'https://acme.co.in/': html });
      const local = await indian.reader.readSite('acme.co.in');
      expect(local.contacts.map((item) => item.value)).toEqual([
        '+912040123456',
      ]);

      const unknown = makeReader({ 'https://acme.com/': html });
      expect((await unknown.reader.readSite('acme.com')).contacts).toEqual([]);

      const hinted = makeReader({ 'https://acme.com/': html });
      const site = await hinted.reader.readSite('acme.com', { country: 'IN' });
      expect(site.contacts.map((item) => item.value)).toEqual([
        '+912040123456',
      ]);
    });

    it('follows profile pages linked from the team page', async () => {
      const { reader } = makeReader({
        'https://acme.com/': page(
          '<a href="/team">Team</a><a href="/contact">Contact</a>',
        ),
        'https://acme.com/team': page(
          '<a href="/team/priya-sharma">Priya Sharma</a><a href="/team/rahul-iyer">Rahul Iyer</a>',
        ),
        'https://acme.com/team/priya-sharma': page(
          '<h1>Priya Sharma</h1><p>VP HR</p><a href="mailto:priya@acme.com">Email Priya</a>',
        ),
        'https://acme.com/team/rahul-iyer': page('<h1>Rahul Iyer</h1>'),
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages.map((item) => item.url)).toEqual([
        'https://acme.com/',
        'https://acme.com/team',
        'https://acme.com/team/priya-sharma',
        'https://acme.com/team/rahul-iyer',
      ]);
      expect(site.pages[2].text).toContain('Email Priya priya@acme.com');
      expect(site.emails).toEqual(['priya@acme.com']);
    });

    it('uses the sitemap when the home page links to no team or contact page', async () => {
      const { reader } = makeReader({
        'https://acme.com/robots.txt': page(
          'User-agent: *\nDisallow: /admin\nSitemap: https://acme.com/sitemap_index.xml',
        ),
        'https://acme.com/': page(
          '<p>Welcome to Acme</p><a href="/pricing">Pricing</a>',
        ),
        'https://acme.com/sitemap_index.xml': page(
          '<sitemapindex><sitemap><loc>https://acme.com/post-sitemap.xml</loc></sitemap><sitemap><loc>https://acme.com/page-sitemap.xml</loc></sitemap></sitemapindex>',
        ),
        'https://acme.com/page-sitemap.xml': page(
          '<urlset><url><loc>https://acme.com/about/leadership</loc></url><url><loc>https://acme.com/admin/team</loc></url><url><loc>https://acme.com/pricing</loc></url></urlset>',
        ),
        'https://acme.com/about/leadership': page('<p>Priya Sharma, VP HR</p>'),
        'https://acme.com/admin/team': page('<p>Private</p>'),
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages.map((item) => item.url)).toEqual([
        'https://acme.com/',
        'https://acme.com/about/leadership',
      ]);
    });

    it('explains when a site needs JavaScript to show anything', async () => {
      const { reader } = makeReader({
        'https://acme.com/': page(
          '<body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body>',
        ),
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages).toEqual([]);
      expect(site.unreachableReason).toMatch(/needs JavaScript/);
    });

    it('does not read a site that disallows crawling', async () => {
      const { reader, transport } = makeReader({
        'https://acme.com/robots.txt': page('User-agent: *\nDisallow: /'),
        'https://acme.com/': page('<p>hello</p>'),
      });
      const site = await reader.readSite('acme.com');
      expect(site.pages).toEqual([]);
      expect(site.unreachableReason).toMatch(/disallows/);
      expect(transport).not.toHaveBeenCalledWith(new URL('https://acme.com/'));
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
        'https://www.acme.com/robots.txt': page(
          'User-agent: *\nDisallow: /secret',
        ),
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
