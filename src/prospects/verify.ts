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

export function normalizeText(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evidenceInText(evidence: string, normalizedPage: string) {
  const needle = normalizeText(evidence).replace(/\.\.\.|…/g, '').trim();
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

function domainMatches(emailDomain: string, companyDomain: string) {
  return (
    emailDomain === companyDomain || emailDomain.endsWith(`.${companyDomain}`)
  );
}

export type RawPerson = {
  firstName?: unknown;
  lastName?: unknown;
  jobTitle?: unknown;
  email?: unknown;
  url?: unknown;
  relevant?: unknown;
};

export type VerifiedPerson = {
  firstName: string;
  lastName: string;
  jobTitle: string;
  email: string | null;
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
  const firstName = typeof person.firstName === 'string' ? person.firstName.trim() : '';
  const lastName = typeof person.lastName === 'string' ? person.lastName.trim() : '';
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
      localPartMatchesName(email, first, last)
    );
  });
  const claimed =
    typeof person.email === 'string' ? person.email.trim().toLowerCase() : '';
  const email = usable.includes(claimed) ? claimed : usable[0] || null;

  const url = typeof person.url === 'string' ? person.url : '';
  return {
    firstName,
    lastName,
    jobTitle: typeof person.jobTitle === 'string' ? person.jobTitle.trim().slice(0, 120) : '',
    email,
    sourceUrl: context.pageUrls.includes(url) ? url : context.fallbackUrl,
    relevant: person.relevant === true,
  };
}
