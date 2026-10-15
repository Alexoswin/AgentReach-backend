import {
  countryFromDomain,
  countryFromLocations,
  countryFromName,
  findPhones,
  parsePhone,
} from './phones';

describe('phones', () => {
  it('finds numbers written for the country and labels their type', () => {
    const found = findPhones(
      'Office +91 20 4012 3456. Mobile 091234 56789. Toll free 1800-123-4567.',
      'IN',
    );
    expect(found.map((phone) => [phone.number, phone.type])).toEqual([
      ['+912040123456', 'landline'],
      ['+919123456789', 'mobile'],
      ['+9118001234567', 'toll_free'],
    ]);
  });

  it('only reads national numbers when the country is known', () => {
    const text = 'Call +91 20 4012 3456 or (415) 555-0199';
    expect(findPhones(text).map((phone) => phone.number)).toEqual([
      '+912040123456',
    ]);
    expect(findPhones('Call (212) 736-4100', 'US')[0].number).toBe(
      '+12127364100',
    );
  });

  it('skips fax numbers, order numbers, bare digit runs and placeholders', () => {
    const text = [
      'Fax: +91 20 4012 9999',
      'Order #9123456789',
      'Ref 9123456789',
      'Phone: 9123456789',
      'Call +91 98765 43210',
      'Mobile +91 99999 99999',
    ].join('\n');
    expect(findPhones(text, 'IN').map((phone) => phone.number)).toEqual([
      '+919123456789',
    ]);
  });

  it('parses tel links and WhatsApp numbers', () => {
    expect(parsePhone('tel:+44 20 7946 0958')?.number).toBe('+442079460958');
    expect(parsePhone('020 7946 0958', 'GB')?.type).toBe('landline');
    expect(parsePhone('020 7946 0958')).toBeNull();
    expect(parsePhone('+919123456789')?.type).toBe('mobile');
    expect(parsePhone('not a number', 'IN')).toBeNull();
  });

  it('works out the country from a domain, a name or the search locations', () => {
    expect(countryFromDomain('acme.co.in')).toBe('IN');
    expect(countryFromDomain('acme.co.uk')).toBe('GB');
    expect(countryFromDomain('acme.io')).toBeUndefined();
    expect(countryFromDomain('acme.com')).toBeUndefined();
    expect(countryFromName('India')).toBe('IN');
    expect(countryFromName('Pune, India')).toBe('IN');
    expect(countryFromName('USA')).toBe('US');
    expect(countryFromName('gb')).toBe('GB');
    expect(countryFromName('Bengaluru')).toBeUndefined();
    expect(countryFromLocations(['India', 'Pune', 'Bengaluru'])).toBe('IN');
    expect(countryFromLocations(['India', 'United States'])).toBeUndefined();
    expect(countryFromLocations([])).toBeUndefined();
  });
});
