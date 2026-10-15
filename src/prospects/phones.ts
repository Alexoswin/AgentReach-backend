import {
  CountryCode,
  findPhoneNumbersInText,
  getCountries,
  isSupportedCountry,
  parsePhoneNumberFromString,
  PhoneNumber,
} from 'libphonenumber-js/max';

export const PHONE_TYPES = ['mobile', 'landline', 'toll_free', 'phone'];

export type FoundPhone = {
  number: string;
  type: string;
  nationalNumber: string;
  country?: CountryCode;
};

const VANITY_TLDS = new Set([
  'ai',
  'cc',
  'co',
  'fm',
  'gg',
  'io',
  'is',
  'la',
  'ly',
  'me',
  'ms',
  'nu',
  'sh',
  'so',
  'st',
  'to',
  'tv',
  'vc',
  'ws',
]);
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  america: 'US',
  'united states of america': 'US',
  uk: 'GB',
  england: 'GB',
  britain: 'GB',
  'great britain': 'GB',
  uae: 'AE',
};
const PHONE_WORDS =
  /\b(phone|tel|call|mobile|mob|cell|contact|whatsapp)|\bph\b|☎|📞/i;

let countryNames: Map<string, CountryCode> | undefined;

function toCountry(code: string): CountryCode | undefined {
  const upper = code.toUpperCase() === 'UK' ? 'GB' : code.toUpperCase();
  return isSupportedCountry(upper) ? upper : undefined;
}

export function countryFromName(value: unknown): CountryCode | undefined {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return undefined;
  if (/^[a-z]{2}$/.test(text)) return toCountry(text);
  if (!countryNames) {
    const display = new Intl.DisplayNames(['en'], { type: 'region' });
    countryNames = new Map(
      getCountries().map((code) => [String(display.of(code)).toLowerCase(), code]),
    );
    for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
      countryNames.set(alias, code as CountryCode);
    }
  }
  const last = text.split(',').pop()?.trim() || '';
  return countryNames.get(text) || countryNames.get(last);
}

export function countryFromDomain(domain: string): CountryCode | undefined {
  const tld = domain.toLowerCase().split('.').pop() || '';
  if (tld.length !== 2 || VANITY_TLDS.has(tld)) return undefined;
  return toCountry(tld);
}

export function countryFromLocations(
  locations: string[],
): CountryCode | undefined {
  const found = new Set(
    locations.map((item) => countryFromName(item)).filter(Boolean),
  );
  return found.size === 1 ? [...found][0] : undefined;
}

function looksFake(national: string, country?: CountryCode) {
  if (/^(\d)\1+$/.test(national)) return true;
  if (
    national.length >= 8 &&
    ('01234567890123456789'.includes(national) ||
      '98765432109876543210'.includes(national))
  ) {
    return true;
  }
  return (country === 'US' || country === 'CA') && national.slice(3, 6) === '555';
}

function describe(phone: PhoneNumber | undefined): FoundPhone | null {
  if (!phone || !phone.isValid()) return null;
  const national = String(phone.nationalNumber);
  if (looksFake(national, phone.country)) return null;
  const kind = phone.getType();
  return {
    number: phone.number,
    type:
      kind === 'MOBILE'
        ? 'mobile'
        : kind === 'FIXED_LINE'
          ? 'landline'
          : kind === 'TOLL_FREE'
            ? 'toll_free'
            : 'phone',
    nationalNumber: national,
    country: phone.country,
  };
}

export function parsePhone(raw: string, country?: CountryCode) {
  const text = raw.replace(/^(tel|callto):/i, '').trim();
  if (!text) return null;
  try {
    return describe(
      parsePhoneNumberFromString(
        text,
        country ? { defaultCountry: country } : undefined,
      ),
    );
  } catch {
    return null;
  }
}

export function findPhones(text: string, country?: CountryCode) {
  const found: Array<FoundPhone & { index: number }> = [];
  for (const match of findPhoneNumbersInText(
    text,
    country ? { defaultCountry: country } : undefined,
  )) {
    const raw = text.slice(match.startsAt, match.endsAt);
    const before = text.slice(Math.max(0, match.startsAt - 30), match.startsAt);
    if (/fax/i.test(before.slice(-12)) || before.endsWith('#')) continue;
    if (/^\d+$/.test(raw) && !PHONE_WORDS.test(before)) continue;
    const phone = describe(match.number);
    if (phone) found.push({ ...phone, index: match.startsAt });
  }
  return found;
}
