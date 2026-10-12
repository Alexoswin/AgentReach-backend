import { analyzeCompany } from './qualify';
import { normalizeProfile } from './icp';
import { applicableCriteria, scoreCriteria } from './scoring';
import { evidenceInText, normalizeText, verifyPerson } from './verify';

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
      { pages: [{ url: 'https://acme.com/', text: PAGE }], emails: [] },
    );
    expect(analysis.criteria[0].verdict).toBe('unknown');
    expect(analysis.criteria[0].evidence).toBe('');
  });
});
