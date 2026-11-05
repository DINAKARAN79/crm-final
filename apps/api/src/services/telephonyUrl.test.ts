import { describe, expect, it } from 'vitest';
import { assertDialpadUrl, buildDialpadUrl, DEFAULT_DIALPAD_URL, TelephonyUrlError } from './telephonyUrl';

describe('assertDialpadUrl', () => {
  it('accepts the approved Bizcall origin', () => {
    expect(assertDialpadUrl(DEFAULT_DIALPAD_URL, { env: 'production' })).toBe(DEFAULT_DIALPAD_URL);
  });

  it('rejects other hosts that are not covered by the application CSP', () => {
    expect(() => assertDialpadUrl('https://dialpad.example.com/embed', { env: 'production' }))
      .toThrowError(TelephonyUrlError);
  });

  it('rejects HTTP URLs in production', () => {
    expect(() => assertDialpadUrl('http://bizcall.cxteletech.com/embed', { env: 'production' }))
      .toThrow('The dialpad URL must use HTTPS and a public host.');
  });

  it('builds the validated URL on the server with an encoded number and explicit auto-dial state', () => {
    const url = new URL(buildDialpadUrl(DEFAULT_DIALPAD_URL, {
      userId: 'crm-user-1',
      number: '+14155552671',
      autoDial: false,
      theme: 'DARK',
    }));
    expect(url.origin).toBe('https://bizcall.cxteletech.com');
    expect(url.searchParams.get('userId')).toBe('crm-user-1');
    expect(url.searchParams.get('number')).toBe('+14155552671');
    expect(url.search).toContain('number=%2B14155552671');
    expect(url.searchParams.get('autocall')).toBe('false');
    expect(url.searchParams.get('theme')).toBe('dark');
  });
});
