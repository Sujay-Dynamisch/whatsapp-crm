import { describe, expect, it } from 'vitest';

import { normalizeWebhookPhone } from './webhook-trigger';

describe('normalizeWebhookPhone', () => {
  it('trusts +international numbers', () => {
    expect(normalizeWebhookPhone('+91 98765-43210')).toBe('919876543210');
  });
  it('adds the default country code to national numbers', () => {
    expect(normalizeWebhookPhone('9876543210', '91')).toBe('919876543210');
    expect(normalizeWebhookPhone('09876543210', '91')).toBe('919876543210');
  });
  it('accepts full international digits and the 00 prefix', () => {
    expect(normalizeWebhookPhone('919876543210')).toBe('919876543210');
    expect(normalizeWebhookPhone('00919876543210', '91')).toBe('919876543210');
  });
  it('rejects junk', () => {
    expect(normalizeWebhookPhone('')).toBeNull();
    expect(normalizeWebhookPhone('call me')).toBeNull();
    expect(normalizeWebhookPhone('12345')).toBeNull();
  });
});
