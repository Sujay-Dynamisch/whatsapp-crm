import { describe, expect, it } from 'vitest';

import { referencesPaymentLink } from './link-once';

describe('referencesPaymentLink', () => {
  it('spots steps that carry {{ vars.payment_link }}', () => {
    expect(referencesPaymentLink({ text: "Here's your link: {{ vars.payment_link }}" })).toBe(true);
    expect(referencesPaymentLink({ template_name: 'sg_nurture_payment', params: ['{{ contact.name }}', '{{ vars.payment_link }}'] })).toBe(true);
    expect(referencesPaymentLink({ text: 'Thanks {{ contact.name }}' })).toBe(false);
    expect(referencesPaymentLink({ text: '{{ vars.payment_link_note }}' })).toBe(false);
  });
});
