import { parsePhone } from './phones';
import type { SiteContact } from './site-reader';

export const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'gmx.com',
  'mail.com',
]);

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;
const ROLE_MAILBOXES = new Set([
  'info',
  'contact',
  'contactus',
  'hello',
  'hi',
  'sales',
  'enquiry',
  'enquiries',
  'inquiry',
  'inquiries',
  'support',
  'help',
  'hr',
  'careers',
  'career',
  'jobs',
  'recruitment',
  'recruiting',
  'talent',
  'hiring',
  'admin',
  'office',
  'business',
  'bd',
  'marketing',
  'partners',
  'partnerships',
  'press',
  'media',
  'pr',
  'team',
  'accounts',
  'billing',
  'finance',
  'service',
  'services',
  'customercare',
  'care',
  'feedback',
  'connect',
  'general',
  'reception',
]);
const NAME_WINDOW = 400;

export function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evidenceInText(evidence: string, normalizedPage: string) {
  const needle = normalizeText(evidence)
    .replace(/\.\.\.|…/g, '')
    .trim();
  return needle.length >= 8 && normalizedPage.includes(needle);
}

export function extractEmails(text: string) {
  const found = new Set<string>();
  for (const match of text.match(EMAIL_PATTERN) || []) {
    const email = match.toLowerCase().replace(/^[._%+-]+|[.]+$/g, '');
    if (!ASSET_EXTENSIONS.test(email)) found.add(email);
  }
  return [...found];
}

function nameToken(value: string) {
  return value.toLowerCase().replace(/[^\p{L}]/gu, '');
}

function fold(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function localPartMatchesName(email: string, first: string, last: string) {
  const local = email.split('@')[0].replace(/[^a-z]/g, '');
  const hasPart = (part: string) =>
    part.length >= 3 ? local.includes(part) : local === part;
  return (
    hasPart(first) ||
    hasPart(last) ||
    local === `${first.slice(0, 1)}${last}` ||
    local === `${first}${last.slice(0, 1)}`
  );
}

export function domainMatches(emailDomain: string, companyDomain: string) {
  return (
    emailDomain === companyDomain || emailDomain.endsWith(`.${companyDomain}`)
  );
}

export function mailboxRole(email: string) {
  const local = email.split('@')[0].toLowerCase().replace(/\+.*$/, '');
  const role = ROLE_MAILBOXES.has(local) ? local : local.split(/[._-]/)[0];
  return ROLE_MAILBOXES.has(role) ? role : '';
}

function decodeSlug(slug: string) {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

export function linkedinUrl(href: string) {
  const match =
    /^(?:(?:https?:)?\/\/)?(?:[a-z]{1,3}\.)?linkedin\.com\/(in|company)\/([^/?#\s]+)/i.exec(
      href.trim(),
    );
  if (!match) return null;
  const slug = decodeSlug(match[2]).toLowerCase();
  if (!/^[\p{L}\p{N}_.-]{2,100}$/u.test(slug)) return null;
  const kind = match[1].toLowerCase();
  return { kind, url: `https://www.linkedin.com/${kind}/${slug}` };
}

export type RawPerson = {
  firstName?: unknown;
  lastName?: unknown;
  jobTitle?: unknown;
  email?: unknown;
  phone?: unknown;
  linkedinUrl?: unknown;
  url?: unknown;
  relevant?: unknown;
};

export type VerifiedPerson = {
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string | null;
  phone: string | null;
  phoneType: string;
  linkedinUrl: string | null;
  sourceUrl: string;
  relevant: boolean;
};

export function verifyPerson(
  person: RawPerson,
  context: {
    normalizedPage: string;
    pageEmails: string[];
    companyDomain: string;
    fallbackUrl: string;
    pageUrls: string[];
  },
): VerifiedPerson | null {
  const firstName =
    typeof person.firstName === 'string' ? person.firstName.trim() : '';
  const lastName =
    typeof person.lastName === 'string' ? person.lastName.trim() : '';
  const first = nameToken(firstName);
  const last = nameToken(lastName);
  if (!first || !last) return null;

  const wholeWord = (token: string) =>
    new RegExp(`(^|[^\\p{L}])${token}($|[^\\p{L}])`, 'u').test(
      context.normalizedPage,
    );
  if (!wholeWord(first) || !wholeWord(last)) return null;

  const usable = context.pageEmails.filter((email) => {
    const domain = email.split('@')[1];
    return (
      !PERSONAL_EMAIL_DOMAINS.has(domain) &&
      domainMatches(domain, context.companyDomain) &&
      localPartMatchesName(email, fold(first), fold(last))
    );
  });
  const claimed =
    typeof person.email === 'string' ? person.email.trim().toLowerCase() : '';
  const email = usable.includes(claimed) ? claimed : usable[0] || null;

  const url = typeof person.url === 'string' ? person.url : '';
  return {
    firstName,
    lastName,
    jobTitle:
      typeof person.jobTitle === 'string'
        ? person.jobTitle.trim().slice(0, 120)
        : '',
    email,
    phone: null,
    phoneType: '',
    linkedinUrl: null,
    sourceUrl: context.pageUrls.includes(url) ? url : context.fallbackUrl,
    relevant: person.relevant === true,
  };
}

function wordIndexes(page: string, token: string) {
  return [...page.matchAll(new RegExp(`(?<!\\p{L})${token}(?!\\p{L})`, 'gu'))].map(
    (match) => match.index ?? 0,
  );
}

function nameStarts(page: string, first: string, last: string) {
  if (!first || !last) return [];
  const firsts = wordIndexes(page, first);
  return wordIndexes(page, last).flatMap((index) => {
    const before = firsts.filter((at) => at < index && index - at <= 40);
    if (before.length) return [before[before.length - 1]];
    return firsts.some((at) => at > index && at - index <= 20) ? [index] : [];
  });
}

function slugMatchesName(url: string, first: string, last: string) {
  const letters = fold(url.split('/').pop() || '').replace(/[^a-z]/g, '');
  const name = fold(first);
  const surname = fold(last);
  return (
    (name.length >= 2 &&
      surname.length >= 2 &&
      letters.includes(name) &&
      letters.includes(surname)) ||
    (surname.length >= 3 && letters.startsWith(`${name.slice(0, 1)}${surname}`))
  );
}

export function verifyContacts(
  person: VerifiedPerson,
  claimed: RawPerson,
  context: {
    normalizedPage: string;
    contacts: SiteContact[];
    others: Array<{ firstName: string; lastName: string }>;
    homeUrl: string;
  },
): Pick<VerifiedPerson, 'phone' | 'phoneType' | 'linkedinUrl'> {
  const first = nameToken(person.firstName);
  const last = nameToken(person.lastName);
  const boundaries = context.others
    .flatMap((other) =>
      nameStarts(
        context.normalizedPage,
        nameToken(other.firstName),
        nameToken(other.lastName),
      ),
    )
    .sort((a, b) => a - b);
  const windows = nameStarts(context.normalizedPage, first, last).map(
    (start) =>
      context.normalizedPage.slice(
        start,
        Math.min(
          start + NAME_WINDOW,
          boundaries.find((index) => index > start) ?? Infinity,
        ),
      ),
  );
  const digits = (text: string) => text.replace(/\D/g, '');

  const said = typeof claimed.phone === 'string' ? digits(claimed.phone) : '';
  const phone =
    said.length >= 6
      ? context.contacts.find((item) => {
          if (item.kind !== 'phone') return false;
          const national = parsePhone(item.value)?.nationalNumber || '';
          const companyLine =
            item.label === 'main' ||
            (item.seen.length >= 2 && item.seen.includes(context.homeUrl));
          return (
            national.length >= 6 &&
            said.endsWith(national) &&
            !companyLine &&
            windows.some((window) => digits(window).includes(national))
          );
        })
      : undefined;

  const profiles = context.contacts.filter(
    (item) => item.kind === 'linkedin' && item.label === 'person',
  );
  const claimedProfile =
    typeof claimed.linkedinUrl === 'string'
      ? linkedinUrl(claimed.linkedinUrl)?.url
      : undefined;
  const named = profiles.filter((item) =>
    slugMatchesName(item.value, first, last),
  );
  const profile =
    profiles.find(
      (item) =>
        item.value === claimedProfile &&
        (named.includes(item) ||
          windows.some((window) =>
            window.includes(item.value.replace('https://www.', '')),
          )),
    ) || (named.length === 1 ? named[0] : undefined);

  return {
    phone: phone?.value || null,
    phoneType: phone ? phone.type || 'phone' : '',
    linkedinUrl: profile?.value || null,
  };
}

const EMAIL_PATTERNS: Array<[string, (first: string, last: string) => string]> =
  [
    ['first.last', (first, last) => `${first}.${last}`],
    ['firstlast', (first, last) => `${first}${last}`],
    ['first_last', (first, last) => `${first}_${last}`],
    ['first-last', (first, last) => `${first}-${last}`],
    ['f.last', (first, last) => `${first.slice(0, 1)}.${last}`],
    ['flast', (first, last) => `${first.slice(0, 1)}${last}`],
    ['firstl', (first, last) => `${first}${last.slice(0, 1)}`],
    ['first', (first) => first],
  ];

export function inferEmailPattern(
  people: Array<{ firstName: string; lastName: string; email?: string | null }>,
) {
  for (const [label, build] of EMAIL_PATTERNS) {
    const matches = people.some((person) => {
      if (!person.email) return false;
      const first = nameToken(person.firstName);
      const last = nameToken(person.lastName);
      return (
        Boolean(first && last) &&
        person.email.split('@')[0].toLowerCase() === build(first, last)
      );
    });
    if (matches) return label;
  }
  return '';
}
