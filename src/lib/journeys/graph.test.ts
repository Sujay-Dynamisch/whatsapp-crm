import { describe, expect, it } from 'vitest';

import {
  defaultConfig,
  durationMs,
  newNode,
  slotsFor,
  starterGraph,
  validateGraph,
  type JourneyGraph,
  type JourneyNode,
} from './graph';
import { isGraphShape, triggerColumns } from './api';

function graphOf(...nodes: JourneyNode[]): JourneyGraph {
  return { nodes };
}
function link(a: JourneyNode, slot: string, b: JourneyNode) {
  a.next[slot] = b.id;
}

describe('graph basics', () => {
  it('slots per node type', () => {
    expect(slotsFor('condition')).toEqual(['yes', 'no']);
    expect(slotsFor('wait_for_reply')).toEqual(['replied', 'timeout']);
    expect(slotsFor('end')).toEqual([]);
    expect(slotsFor('send_template')).toEqual(['next']);
  });

  it('defaults are fresh copies', () => {
    const a = defaultConfig('send_template');
    a.params!.push('x');
    expect(defaultConfig('send_template').params).toEqual([]);
  });

  it('durations', () => {
    expect(durationMs(2, 'hours')).toBe(7_200_000);
    expect(durationMs(-5, 'days')).toBe(0);
  });

  it('the starter graph is valid once its trigger is set', () => {
    expect(validateGraph(starterGraph())).toEqual([]);
  });
});

describe('validateGraph', () => {
  it('requires exactly one trigger', () => {
    const end = newNode('end', undefined, 'e');
    expect(validateGraph(graphOf(end)).map((i) => i.message)).toContain('A journey needs exactly one trigger');
  });

  it('flags unconnected and dangling slots', () => {
    const t = newNode('trigger', undefined, 't');
    const c = newNode('condition', undefined, 'c');
    link(t, 'next', c);
    c.next.yes = 'missing';
    const msgs = validateGraph(graphOf(t, c)).filter((i) => i.nodeId === 'c').map((i) => i.message);
    expect(msgs).toEqual(expect.arrayContaining(['"yes" points to a missing step', '"no" is not connected']));
  });

  it('flags unreachable steps', () => {
    const t = newNode('trigger', undefined, 't');
    const e = newNode('end', undefined, 'e');
    const orphan = newNode('end', undefined, 'o');
    link(t, 'next', e);
    expect(validateGraph(graphOf(t, e, orphan))).toEqual([
      { nodeId: 'o', message: 'Not reachable from the trigger' },
    ]);
  });

  it('flags loops without a wait, but allows loops through a wait', () => {
    const t = newNode('trigger', undefined, 't');
    const a = newNode('add_tag', undefined, 'a');
    a.config = { tag_id: 'tag-1' };
    const c = newNode('condition', undefined, 'c');
    const e = newNode('end', undefined, 'e');
    link(t, 'next', a);
    link(a, 'next', c);
    link(c, 'yes', a); // loop with no wait
    link(c, 'no', e);
    const loopy = validateGraph(graphOf(t, a, c, e)).filter((i) => i.message.includes('loop'));
    expect(loopy.map((i) => i.nodeId).sort()).toEqual(['a', 'c']);

    const w = newNode('wait', undefined, 'w');
    link(c, 'yes', w);
    link(w, 'next', a);
    expect(validateGraph(graphOf(t, a, c, w, e))).toEqual([]);
  });

  it('checks required config', () => {
    const t = newNode('trigger', undefined, 't');
    t.config = { trigger_type: 'tag_added' };
    const s = newNode('send_template', undefined, 's');
    const w = newNode('wait', undefined, 'w');
    w.config = { amount: 200, unit: 'days' };
    const e = newNode('end', undefined, 'e');
    link(t, 'next', s);
    link(s, 'next', w);
    link(w, 'next', e);
    const msgs = validateGraph(graphOf(t, s, w, e)).map((i) => `${i.nodeId}: ${i.message}`);
    expect(msgs).toEqual([
      't: Choose the tag that starts the journey',
      's: Choose a template',
      'w: Waits are limited to 90 days',
    ]);
  });

  it('rejects garbage', () => {
    expect(validateGraph(null)).toEqual([{ nodeId: null, message: 'Graph has no nodes' }]);
    expect(isGraphShape({ nodes: [{ id: 'x' }] })).toBe(false);
    expect(isGraphShape(starterGraph())).toBe(true);
  });
});

describe('workflow steps (054)', () => {
  const wire = (...nodes: JourneyNode[]) => ({ nodes });

  it('switch slots follow its cases; http/code have an optional error slot', () => {
    const sw = newNode('switch', undefined, 'sw') as JourneyNode;
    sw.config = { value: '{{ reply.text }}', cases: [{ op: 'equals', value: 'a' }, { op: 'equals', value: 'b' }] };
    expect(slotsFor(sw)).toEqual(['case_0', 'case_1', 'default']);
    expect(slotsFor('http_request')).toEqual(['success', 'error']);

    const t = newNode('trigger', undefined, 't') as JourneyNode;
    const h = newNode('http_request', undefined, 'h') as JourneyNode;
    h.config = { ...(h.config as object), url: 'https://api.example.com' } as never;
    const e = newNode('end', undefined, 'e') as JourneyNode;
    t.next.next = 'h';
    h.next.success = 'e';
    expect(validateGraph(wire(t, h, e))).toEqual([]);
  });

  it('a loop step breaks a cycle, a plain cycle does not', () => {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    const l = newNode('loop', undefined, 'l') as JourneyNode;
    l.config = { items: '{{ trigger.items }}', max: 10 };
    const s = newNode('remove_tag', undefined, 's') as JourneyNode;
    s.config = { tag_id: 'x' };
    const e = newNode('end', undefined, 'e') as JourneyNode;
    t.next.next = 'l';
    l.next = { each: 's', done: 'e' };
    s.next.next = 'l';
    expect(validateGraph(wire(t, l, s, e))).toEqual([]);
  });

  it('checks the new configs', () => {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    t.config = { trigger_type: 'schedule', mode: 'interval', every: 1, unit: 'minutes' };
    const v = newNode('set_variable', undefined, 'v') as JourneyNode;
    v.config = { assignments: [{ key: '2bad', value: 'x' }] };
    const b = newNode('send_buttons', undefined, 'b') as JourneyNode;
    b.config = { text: 'Pick', buttons: [{ title: 'This title is far too long' }] };
    const e = newNode('end', undefined, 'e') as JourneyNode;
    t.next.next = 'v';
    v.next.next = 'b';
    b.next.next = 'e';
    const msgs = validateGraph(wire(t, v, b, e)).map((i) => `${i.nodeId}: ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        't: Choose which contacts (tag) the schedule runs for',
        't: Run at most every 5 minutes',
        'v: "2bad" is not a valid variable name (letters, digits, _)',
        'b: "This title is far too long" is longer than 20 characters',
      ])
    );
  });

  it('webhook triggers need a phone mapping', () => {
    const t = newNode('trigger', undefined, 't') as JourneyNode;
    t.config = { trigger_type: 'webhook', phone: '' };
    const e = newNode('end', undefined, 'e') as JourneyNode;
    t.next.next = 'e';
    expect(validateGraph(wire(t, e)).map((i) => i.message)).toContain(
      'Map the customer phone number from the webhook data'
    );
  });
});

describe('triggerColumns', () => {
  it('copies only the relevant trigger config', () => {
    const g = starterGraph();
    g.nodes[0].config = { trigger_type: 'button_clicked', button_text: '  Buy now ', tag_id: 'ignored' };
    expect(triggerColumns(g)).toEqual({
      trigger_type: 'button_clicked',
      trigger_config: { button_text: 'Buy now' },
    });
  });
});
