import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, contentFingerprint, dedupeHash } from './dedupe';

describe('canonicalizeUrl', () => {
  it('strips utm and tracking params', () => {
    expect(canonicalizeUrl('https://example.com/job/1?utm_source=api&utm_medium=x')).toBe(
      'https://example.com/job/1',
    );
  });

  it('strips Adzuna per-request signature params', () => {
    // `se` and `v` change between requests for the same ad; the id in the path
    // is the stable identity. Without this, every poll would look like a new job.
    const a = canonicalizeUrl('https://www.adzuna.com.au/land/ad/4100000001?se=abc&v=BUILD1');
    const b = canonicalizeUrl('https://www.adzuna.com.au/land/ad/4100000001?se=zzz&v=BUILD9');
    expect(a).toBe(b);
  });

  it('normalises host case and drops www', () => {
    expect(canonicalizeUrl('https://WWW.Example.com/job/1')).toBe('https://example.com/job/1');
  });

  it('upgrades http to https', () => {
    expect(canonicalizeUrl('http://example.com/job/1')).toBe('https://example.com/job/1');
  });

  it('drops the fragment', () => {
    expect(canonicalizeUrl('https://example.com/job/1#apply')).toBe('https://example.com/job/1');
  });

  it('sorts remaining params so order does not create a false new listing', () => {
    expect(canonicalizeUrl('https://example.com/j?b=2&a=1')).toBe(
      canonicalizeUrl('https://example.com/j?a=1&b=2'),
    );
  });

  it('keeps meaningful params', () => {
    expect(canonicalizeUrl('https://example.com/job?id=99')).toContain('id=99');
  });

  it('falls back gracefully on an unparseable URL', () => {
    // Still deterministic, so a malformed link dedupes against itself.
    expect(canonicalizeUrl('  NOT A URL  ')).toBe('not a url');
  });
});

describe('dedupeHash', () => {
  it('is stable for equivalent URLs', () => {
    expect(dedupeHash('https://example.com/job/1?utm_source=a')).toBe(
      dedupeHash('http://www.example.com/job/1#x'),
    );
  });

  it('differs for genuinely different jobs', () => {
    expect(dedupeHash('https://example.com/job/1')).not.toBe(
      dedupeHash('https://example.com/job/2'),
    );
  });
});

describe('contentFingerprint', () => {
  it('matches the same job advertised with different boilerplate', () => {
    expect(contentFingerprint('Cyber Security Analyst - URGENT', 'Acme Pty Ltd')).toBe(
      contentFingerprint('Cyber Security Analyst (job)', 'Acme Pty Ltd'),
    );
  });

  it('ignores punctuation and case', () => {
    expect(contentFingerprint('IT  Support/Officer', 'Acme')).toBe(
      contentFingerprint('it support officer', 'ACME'),
    );
  });

  it('separates different companies advertising the same title', () => {
    expect(contentFingerprint('SOC Analyst', 'Acme')).not.toBe(
      contentFingerprint('SOC Analyst', 'Globex'),
    );
  });

  it('handles a null company', () => {
    expect(() => contentFingerprint('SOC Analyst', null)).not.toThrow();
  });
});
