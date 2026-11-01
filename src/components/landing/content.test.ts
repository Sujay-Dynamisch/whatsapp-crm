import { describe, expect, it } from 'vitest';

import { CONTACT, PAYMENT, PLANS, paidLink, purchaseLink, upiLink } from './content';

const plan = (name: string) => PLANS.find((p) => p.name === name)!;
const text = (url: string) => new URL(url).searchParams.get('text');

describe('pricing links', () => {
  it('“Choose plan” opens the WhatsApp chat with the plan and price', () => {
    const url = purchaseLink(plan('Growth'));
    expect(url.startsWith(`https://wa.me/${CONTACT.phone}?`)).toBe(true);
    expect(text(url)).toBe(
      'Hi Sujal, I want to subscribe to the Growth plan (₹1,999/month) of the WhatsApp CRM. Please share the payment details.'
    );
    expect(text(purchaseLink(plan('Enterprise')))).toContain('Enterprise plan');
  });

  it('UPI link has the UPI ID, exact amount, INR and a note', () => {
    expect(PAYMENT.upiId).toBe('khedekarsujay5-1@okicici');
    for (const [name, amount] of [['Starter', '999.00'], ['Growth', '1999.00'], ['Business', '3999.00']] as const) {
      const url = upiLink(plan(name));
      expect(url.startsWith('upi://pay?pa=khedekarsujay5-1@okicici&')).toBe(true); // raw "@"
      expect(url).not.toContain('+'); // spaces as %20
      const q = new URLSearchParams(url.slice('upi://pay?'.length));
      expect(Object.fromEntries(q)).toEqual({
        pa: 'khedekarsujay5-1@okicici',
        pn: 'wacrm',
        am: amount,
        cu: 'INR',
        tn: `wacrm ${name} plan - 1 month`,
      });
    }
  });

  it('every paid plan has an amount matching its price; Enterprise has none', () => {
    for (const p of PLANS) {
      if (p.name === 'Enterprise') expect(p.amount).toBeUndefined();
      else expect(p.price).toBe(`₹${p.amount!.toLocaleString('en-IN')}`);
    }
  });

  it('“Paid?” message names the plan and price', () => {
    expect(text(paidLink(plan('Business')))).toBe(
      "Hi Sujal, I've paid ₹3,999 via UPI for the Business plan (1 month) of the WhatsApp CRM. UPI reference: "
    );
  });
});
