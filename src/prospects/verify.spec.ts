import { analyzeCompany, companyContacts } from './qualify';
import { normalizeProfile } from './icp';
import { applicableCriteria, scoreCriteria } from './scoring';
import type { SiteContact } from './site-reader';
import {
  evidenceInText,
  inferEmailPattern,
  linkedinUrl,
  mailboxRole,
  normalizeText,
  verifyContacts,
  verifyPerson,
} from './verify';

const contact = (
  kind: SiteContact['kind'],
  value: string,
  extra: Partial<SiteContact> = {},
): SiteContact => ({
  kind,
  value,
  url: 'https://acme.com/team',
  label: '',
  seen: ['https://acme.com/team'],
  ...extra,
});

const PAGE =
  'Acme builds software for banks. 450 engineers. Priya Sharma, VP HR. Contact priya.sharma@acme.com or info@acme.com. Rahul Iyer, Head of Talent.';
const context = {
  normalizedPage: normalizeText(PAGE),
  pageEmails: ['priya.sharma@acme.com', 'info@acme.com', 'someone@gmail.com'],
  companyDomain: 'acme.com',
  fallbackUrl: 'https://acme.com/team',
  pageUrls: ['https://acme.com/team'],
};

describe('verification', () => {
  it('accepts quotes that are on the page and rejects invented ones', () => {
    expect(
      evidenceInText('Acme builds software for banks', context.normalizedPage),
    ).toBe(true);
    expect(evidenceInText('450 ENGINEERS.', context.normalizedPage)).toBe(true);
    expect(
      evidenceInText(
        'We are the leading bank in India',
        context.normalizedPage,
      ),
    ).toBe(false);
    expect(evidenceInText('banks', context.normalizedPage)).toBe(false);
  });

  it('keeps a published work email that belongs to the person', () => {
    const person = verifyPerson(
      {
        firstName: 'Priya',
        lastName: 'Sharma',
        jobTitle: 'VP HR',
        email: 'priya.sharma@acme.com',
        relevant: true,
      },
      context,
    );
    expect(person?.email).toBe('priya.sharma@acme.com');
    expect(person?.relevant).toBe(true);
  });

  it('never accepts an email that is not on the page', () => {
    const person = verifyPerson(
      { firstName: 'Rahul', lastName: 'Iyer', email: 'rahul.iyer@acme.com' },
      context,
    );
    expect(person).not.toBeNull();
    expect(person?.email).toBeNull();
  });

  it('rejects role mailboxes, personal domains and other companies', () => {
    const wrong = verifyPerson(
      {
        firstName: 'Rahul',
        lastName: 'Iyer',
        email: 'info@acme.com',
      },
      context,
    );
    expect(wrong?.email).toBeNull();

    const personal = verifyPerson(
      { firstName: 'Priya', lastName: 'Sharma', email: 'someone@gmail.com' },
      context,
    );
    expect(personal?.email).toBe('priya.sharma@acme.com');

    const other = verifyPerson(
      { firstName: 'Priya', lastName: 'Sharma' },
      { ...context, companyDomain: 'other.com' },
    );
    expect(other?.email).toBeNull();
  });

  it('drops people whose name is not on the pages', () => {
    expect(
      verifyPerson({ firstName: 'Made', lastName: 'Up' }, context),
    ).toBeNull();
    expect(verifyPerson({ firstName: 'Priya' }, context)).toBeNull();
  });

  it('matches a mailbox to a name written with accents', () => {
    const person = verifyPerson(
      { firstName: 'José', lastName: 'Muñoz' },
      {
        ...context,
        normalizedPage: normalizeText('José Muñoz, CTO'),
        pageEmails: ['jose.munoz@acme.com'],
      },
    );
    expect(person?.email).toBe('jose.munoz@acme.com');
  });

  it('recognises role mailboxes', () => {
    expect(mailboxRole('sales@acme.com')).toBe('sales');
    expect(mailboxRole('info.india@acme.com')).toBe('info');
    expect(mailboxRole('priya.sharma@acme.com')).toBe('');
    expect(mailboxRole('noreply@acme.com')).toBe('');
  });

  it('normalizes LinkedIn links', () => {
    expect(
      linkedinUrl('https://in.linkedin.com/in/Priya-Sharma/?trk=people'),
    ).toEqual({
      kind: 'in',
      url: 'https://www.linkedin.com/in/priya-sharma',
    });
    expect(linkedinUrl('linkedin.com/company/acme')).toEqual({
      kind: 'company',
      url: 'https://www.linkedin.com/company/acme',
    });
    expect(linkedinUrl('https://www.linkedin.com/feed/')).toBeNull();
  });
});

describe('verifyContacts', () => {
  const page = normalizeText(
    [
      'Priya Sharma, VP HR, +91 91234 56789, linkedin.com/in/priya-sharma',
      'Rahul Iyer, Head of Talent, +91 99887 76655',
      'Nina Rao, CEO',
      'Main office +91 20 4012 3456',
    ].join('\n'),
  );
  const contacts = [
    contact('phone', '+919123456789', { type: 'mobile' }),
    contact('phone', '+919988776655', { type: 'mobile' }),
    contact('phone', '+912040123456', { type: 'landline', label: 'main' }),
    contact('linkedin', 'https://www.linkedin.com/in/priya-sharma', {
      label: 'person',
    }),
    contact('linkedin', 'https://www.linkedin.com/in/rahul-iyer-12', {
      label: 'person',
    }),
  ];
  const people = [
    ['Priya', 'Sharma'],
    ['Rahul', 'Iyer'],
    ['Nina', 'Rao'],
  ].map(([firstName, lastName]) => ({
    firstName,
    lastName,
    jobTitle: '',
    email: null,
    phone: null,
    phoneType: '',
    linkedinUrl: null,
    sourceUrl: '',
    relevant: true,
  }));
  const check = (
    index: number,
    claimed: Record<string, unknown>,
    found: SiteContact[] = contacts,
  ) =>
    verifyContacts(people[index], claimed, {
      normalizedPage: page,
      contacts: found,
      others: people.filter((_, other) => other !== index),
      homeUrl: 'https://acme.com/',
    });

  it('keeps a phone and profile listed with the person', () => {
    expect(
      check(0, {
        phone: '+91 91234 56789',
        linkedinUrl: 'https://linkedin.com/in/priya-sharma',
      }),
    ).toEqual({
      phone: '+919123456789',
      phoneType: 'mobile',
      linkedinUrl: 'https://www.linkedin.com/in/priya-sharma',
    });
  });

  it("rejects another person's phone, the main line and invented values", () => {
    expect(check(0, { phone: '+91 99887 76655' }).phone).toBeNull();
    expect(check(2, { phone: '+91 20 4012 3456' }).phone).toBeNull();
    expect(check(2, { phone: '+91 91111 22222' }).phone).toBeNull();
    expect(
      check(2, { linkedinUrl: 'https://linkedin.com/in/priya-sharma' })
        .linkedinUrl,
    ).toBeNull();
  });

  it('links a profile whose address names the person', () => {
    expect(check(1, {}).linkedinUrl).toBe(
      'https://www.linkedin.com/in/rahul-iyer-12',
    );
  });

  it('treats a number on the home page and other pages as a company line', () => {
    const shared = [
      contact('phone', '+919123456789', {
        type: 'mobile',
        seen: ['https://acme.com/', 'https://acme.com/team'],
      }),
    ];
    expect(check(0, { phone: '+91 91234 56789' }, shared).phone).toBeNull();
  });
});

describe('scoring', () => {
  const profile = normalizeProfile({
    industries: ['IT services'],
    companySize: { min: 200, max: 1000 },
    locations: ['India'],
    signals: ['hiring'],
  });
  const verdict = (key: string, value: 'yes' | 'no' | 'unknown') => ({
    key,
    label: key,
    verdict: value,
    evidence: '',
    url: '',
  });

  it('only counts criteria the profile specifies', () => {
    expect(applicableCriteria(profile).map((item) => item.key)).toEqual([
      'industry',
      'size',
      'location',
      'signals',
    ]);
    expect(
      applicableCriteria(normalizeProfile({})).map((item) => item.key),
    ).toEqual(['industry']);
  });

  it('weights confirmed criteria only', () => {
    expect(
      scoreCriteria([
        verdict('industry', 'yes'),
        verdict('size', 'yes'),
        verdict('location', 'yes'),
        verdict('signals', 'unknown'),
      ]),
    ).toBe(71);
    expect(scoreCriteria([verdict('industry', 'no')])).toBe(0);
  });
});

describe('analyzeCompany', () => {
  it('downgrades a verdict whose quote is not on the page', async () => {
    const profile = normalizeProfile({ industries: ['banking software'] });
    const analysis = await analyzeCompany(
      async () => ({
        summary: 'Makes banking software',
        excluded: false,
        criteria: {
          industry: {
            verdict: 'yes',
            evidence: 'The number one banking software vendor',
            url: 'https://acme.com/',
          },
        },
        people: [],
      }),
      profile,
      { name: 'Acme', domain: 'acme.com' },
      {
        pages: [{ url: 'https://acme.com/', text: PAGE }],
        emails: [],
        contacts: [],
      },
    );
    expect(analysis.criteria[0].verdict).toBe('unknown');
    expect(analysis.criteria[0].evidence).toBe('');
  });

  it("keeps a person's phone and the company's own mailboxes and lines", async () => {
    const url = 'https://acme.com/team';
    const site = {
      pages: [
        {
          url,
          text: 'Priya Sharma, VP HR, +91 91234 56789, priya.sharma@acme.com. Write to sales@acme.com or info@acme.com. Main line +91 20 4012 3456.',
        },
      ],
      emails: [],
      contacts: [
        contact('email', 'priya.sharma@acme.com'),
        contact('email', 'sales@acme.com'),
        contact('email', 'info@acme.com'),
        contact('email', 'noreply@acme.com'),
        contact('email', 'acme.help@gmail.com'),
        contact('email', 'partner@other.com'),
        contact('phone', '+919123456789', { type: 'mobile' }),
        contact('phone', '+912040123456', { type: 'landline', label: 'main' }),
        contact('linkedin', 'https://www.linkedin.com/company/acme', {
          label: 'company',
        }),
      ],
    };
    const analysis = await analyzeCompany(
      async () => ({
        summary: 'Acme makes banking software.',
        people: [
          {
            firstName: 'Priya',
            lastName: 'Sharma',
            jobTitle: 'VP HR',
            phone: '+91 91234 56789',
            url,
          },
        ],
      }),
      normalizeProfile({}),
      { name: 'Acme', domain: 'acme.com' },
      site,
      { peopleOnly: true },
    );
    expect(analysis.people[0]).toMatchObject({
      email: 'priya.sharma@acme.com',
      phone: '+919123456789',
      phoneType: 'mobile',
    });
    expect(
      companyContacts(site, { domain: 'acme.com' }, analysis.people),
    ).toEqual({
      emails: [
        { value: 'sales@acme.com', label: 'sales', url },
        { value: 'info@acme.com', label: 'info', url },
      ],
      phones: [
        { value: '+912040123456', type: 'landline', label: 'main', url },
      ],
      linkedinUrl: 'https://www.linkedin.com/company/acme',
    });
  });
});

describe('inferEmailPattern', () => {
  it('names the pattern that published addresses follow', () => {
    expect(
      inferEmailPattern([
        {
          firstName: 'Priya',
          lastName: 'Sharma',
          email: 'priya.sharma@acme.com',
        },
        { firstName: 'Rahul', lastName: 'Iyer' },
      ]),
    ).toBe('first.last');
    expect(
      inferEmailPattern([
        { firstName: 'Priya', lastName: 'Sharma', email: 'psharma@acme.com' },
      ]),
    ).toBe('flast');
    expect(
      inferEmailPattern([
        { firstName: 'Priya', lastName: 'Sharma', email: 'hello@acme.com' },
      ]),
    ).toBe('');
  });
});
