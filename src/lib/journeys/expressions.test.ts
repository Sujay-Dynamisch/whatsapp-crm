import { describe, expect, it } from 'vitest';

import {
  compare,
  emptyScope,
  evaluateValue,
  parsePath,
  renderTemplate,
  resolvePath,
  type ExprScope,
} from './expressions';

const scope: ExprScope = {
  ...emptyScope(new Date('2026-10-20T10:00:00Z')),
  contact: { name: 'Asha', phone: '919876543210', email: '' },
  trigger: { body: { order: { id: 'A-1', total: '1499.5', items: [{ sku: 'x' }, { sku: 'y' }] } } },
  nodes: { n_http: { status: 200, body: { 'first name': 'Ravi', list: [1, 2, 3] } } },
  vars: { coupon: 'DIWALI20' },
  reply: { text: 'Yes please' },
  item: { sku: 'y' },
  index: 1,
};

describe('parsePath', () => {
  it('handles dots, indexes and quoted keys', () => {
    expect(parsePath('a.b[0]["c d"]')).toEqual(['a', 'b', 0, 'c d']);
    expect(parsePath("nodes.x['k']")).toEqual(['nodes', 'x', 'k']);
  });
  it('rejects garbage', () => {
    expect(parsePath('a..b')).toBeNull();
    expect(parsePath('a b')).toBeNull();
    expect(parsePath('')).toBeNull();
  });
});

describe('resolvePath', () => {
  it('reads every root', () => {
    expect(resolvePath(scope, 'contact.name')).toBe('Asha');
    expect(resolvePath(scope, 'trigger.body.order.items[1].sku')).toBe('y');
    expect(resolvePath(scope, 'nodes.n_http.body["first name"]')).toBe('Ravi');
    expect(resolvePath(scope, 'vars.coupon')).toBe('DIWALI20');
    expect(resolvePath(scope, 'item.sku')).toBe('y');
    expect(resolvePath(scope, 'index')).toBe(1);
    expect(resolvePath(scope, 'nodes.n_http.body.list.length')).toBe(3);
  });
  it('keeps the legacy aliases', () => {
    expect(resolvePath(scope, 'name')).toBe('Asha');
    expect(resolvePath(scope, 'phone')).toBe('919876543210');
  });
  it('never walks the prototype chain', () => {
    expect(resolvePath(scope, 'contact.constructor')).toBeUndefined();
    expect(resolvePath(scope, 'vars.__proto__')).toBeUndefined();
    expect(resolvePath(scope, 'process.env')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  it('fills placeholders and applies filters', () => {
    expect(renderTemplate('Hi {{ contact.name | upper }}, order {{trigger.body.order.id}}', scope)).toBe(
      'Hi ASHA, order A-1'
    );
    expect(renderTemplate('{{ contact.email | default:"no email" }}', scope)).toBe('no email');
    expect(renderTemplate('{{ trigger.body.order.total | number | round:0 }}', scope)).toBe('1500');
    expect(renderTemplate('{{ nodes.n_http.body.list | join:"-" }}', scope)).toBe('1-2-3');
    expect(renderTemplate('{{ reply.text | replace:"Yes","No" }}', scope)).toBe('No please');
    expect(renderTemplate('{{name}} / {{ missing.path }}!', scope)).toBe('Asha / !');
  });
  it('renders objects as JSON and escapes when asked', () => {
    expect(renderTemplate('{{ item }}', scope)).toBe('{"sku":"y"}');
    expect(renderTemplate('{"msg":"{{ reply.text }}"}', { ...scope, reply: { text: 'say "hi"' } }, (s) =>
      JSON.stringify(s).slice(1, -1)
    )).toBe('{"msg":"say \\"hi\\""}');
  });
});

describe('evaluateValue', () => {
  it('keeps the type of a lone placeholder', () => {
    expect(evaluateValue('{{ trigger.body.order.items }}', scope)).toEqual([{ sku: 'x' }, { sku: 'y' }]);
    expect(evaluateValue('{{ index }}', scope)).toBe(1);
    expect(evaluateValue('Order {{ trigger.body.order.id }}', scope)).toBe('Order A-1');
  });
});

describe('compare', () => {
  it('compares numbers numerically and text case-insensitively', () => {
    expect(compare('equals', '10', 10)).toBe(true);
    expect(compare('equals', 'YES', 'yes')).toBe(true);
    expect(compare('gt', '1499.5', '200')).toBe(true);
    expect(compare('lt', '2026-01-01', '2026-02-01')).toBe(true);
    expect(compare('contains', 'Yes please', 'yes')).toBe(true);
    expect(compare('contains', ['a', 'b'], 'B')).toBe(true);
    expect(compare('starts_with', 'Hello', 'he')).toBe(true);
    expect(compare('is_empty', '  ', '')).toBe(true);
    expect(compare('not_empty', [1], '')).toBe(true);
  });
  it('treats bad regexes as no match', () => {
    expect(compare('regex', 'order 42', '\\d+')).toBe(true);
    expect(compare('regex', 'x', '(')).toBe(false);
  });
});
