import { describe, it, expect } from 'vitest';
import { isUnsubscribeText, isContactUnsubscribed } from './unsubscribe';

describe('isUnsubscribeText', () => {
  it('identifies exact stop/unsubscribe keywords', () => {
    expect(isUnsubscribeText('stop')).toBe(true);
    expect(isUnsubscribeText('STOP')).toBe(true);
    expect(isUnsubscribeText('unsubscribe')).toBe(true);
    expect(isUnsubscribeText('UNSUBSCRIBE')).toBe(true);
    expect(isUnsubscribeText('optout')).toBe(true);
    expect(isUnsubscribeText('opt-out')).toBe(true);
    expect(isUnsubscribeText('cancel')).toBe(true);
  });

  it('identifies stop phrases', () => {
    expect(isUnsubscribeText('stop messaging')).toBe(true);
    expect(isUnsubscribeText('please stop')).toBe(true);
    expect(isUnsubscribeText('pls stop')).toBe(true);
    expect(isUnsubscribeText("don't send messages")).toBe(true);
    expect(isUnsubscribeText('stop whatsapp')).toBe(true);
    expect(isUnsubscribeText('no more messages')).toBe(true);
  });

  it('rejects normal messages', () => {
    expect(isUnsubscribeText('hello')).toBe(false);
    expect(isUnsubscribeText('can you help me with pricing?')).toBe(false);
    expect(isUnsubscribeText('I want to stop by your store tomorrow')).toBe(false);
    expect(isUnsubscribeText(null)).toBe(false);
    expect(isUnsubscribeText('')).toBe(false);
  });
});

describe('isContactUnsubscribed', () => {
  it('returns true if contact has unsubscribe tag', () => {
    const contact = {
      tags: [
        { id: '1', name: 'VIP', color: '#000', user_id: 'u1', created_at: '' },
        { id: '2', name: 'unsubscribe', color: '#f00', user_id: 'u1', created_at: '' },
      ],
    };
    expect(isContactUnsubscribed(contact)).toBe(true);
  });

  it('returns false if contact has no unsubscribe tag', () => {
    const contact = {
      tags: [
        { id: '1', name: 'VIP', color: '#000', user_id: 'u1', created_at: '' },
      ],
    };
    expect(isContactUnsubscribed(contact)).toBe(false);
    expect(isContactUnsubscribed(null)).toBe(false);
  });
});
