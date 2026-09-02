import { describe, expect, it } from 'vitest';
import { isAccountLevelFailure, summariseAccountFailure } from './scoring-run';

/**
 * Exhausted credits produced 53 identical failed batches in one cycle, and
 * would have repeated that every cycle until someone read the journal.
 */
describe('isAccountLevelFailure', () => {
  const exhausted =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
    '"Your credit balance is too low to access the Anthropic API. Please go to ' +
    'Plans & Billing to upgrade or purchase credits."}}';

  it('recognises the real exhausted-credits payload', () => {
    expect(isAccountLevelFailure(exhausted)).toBe(true);
    expect(summariseAccountFailure(exhausted)).toMatch(/credit balance is exhausted/i);
  });

  it('recognises a rejected key', () => {
    expect(isAccountLevelFailure('401 authentication_error: invalid x-api-key')).toBe(true);
    expect(summariseAccountFailure('401 authentication_error')).toMatch(/rejected/i);
  });

  it('does NOT stop on failures a retry could fix', () => {
    // These are per-batch problems. Stopping the whole run on one would leave
    // the rest of the queue unscored for no reason.
    expect(isAccountLevelFailure('529 overloaded_error')).toBe(false);
    expect(isAccountLevelFailure('500 internal server error')).toBe(false);
    expect(isAccountLevelFailure('batch returned 6 scores for 8 listings')).toBe(false);
    expect(isAccountLevelFailure('fetch failed')).toBe(false);
  });

  it('does not mistake a rate limit for an account failure', () => {
    // 429 is temporary and the SDK already backs off; treating it as fatal
    // would stop a run that was going to succeed.
    expect(isAccountLevelFailure('429 rate_limit_error: too many requests')).toBe(false);
  });
});
