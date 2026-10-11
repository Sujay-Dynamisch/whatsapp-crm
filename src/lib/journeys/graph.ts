// ============================================================
// Journey graph model (migration 050). Pure — shared by the canvas
// editor (browser), the API (validation on save/activate) and the
// engine (server).
//
// A graph is a list of nodes. Each node names its outgoing
// connections in `next`, keyed by slot: most nodes have one slot
// ("next"); branching nodes have two (condition: yes/no, wait for
// reply: replied/timeout). Keeping edges inside nodes means there is
// no separate edge list to drift out of sync.
// ============================================================

export type JourneyTriggerType =
  | 'manual'
  | 'contact_created'
  | 'first_message'
  | 'tag_added'
  | 'button_clicked';

export const TRIGGER_TYPES: JourneyTriggerType[] = [
  'manual',
  'contact_created',
  'first_message',
  'tag_added',
  'button_clicked',
];

export type DurationUnit = 'minutes' | 'hours' | 'days';

export type ConditionKind = 'has_tag' | 'clicked_button' | 'replied' | 'window_open';

export interface NodeConfigs {
  trigger: { trigger_type: JourneyTriggerType; tag_id?: string; button_text?: string };
  wait: { amount: number; unit: DurationUnit };
  wait_for_reply: { amount: number; unit: DurationUnit };
  condition: { kind: ConditionKind; tag_id?: string; button_text?: string };
  send_template: { template_name: string; language?: string; params?: string[] };
  send_text: { text: string };
  add_tag: { tag_id: string };
  remove_tag: { tag_id: string };
  create_deal: { pipeline_id: string; stage_id: string; title: string; value?: number };
  end: Record<string, never>;
}

export type JourneyNodeType = keyof NodeConfigs;

export interface JourneyNode<T extends JourneyNodeType = JourneyNodeType> {
  id: string;
  type: T;
  config: NodeConfigs[T];
  /** slot → target node id */
  next: Record<string, string | undefined>;
  position: { x: number; y: number };
}

export interface JourneyGraph {
  nodes: JourneyNode[];
}

export const NODE_TYPES: JourneyNodeType[] = [
  'trigger',
  'wait',
  'wait_for_reply',
  'condition',
  'send_template',
  'send_text',
  'add_tag',
  'remove_tag',
  'create_deal',
  'end',
];

/** Outgoing slots per node type, in display order. */
export function slotsFor(type: JourneyNodeType): string[] {
  switch (type) {
    case 'condition':
      return ['yes', 'no'];
    case 'wait_for_reply':
      return ['replied', 'timeout'];
    case 'end':
      return [];
    default:
      return ['next'];
  }
}

export function defaultConfig<T extends JourneyNodeType>(type: T): NodeConfigs[T] {
  const defaults: { [K in JourneyNodeType]: NodeConfigs[K] } = {
    trigger: { trigger_type: 'manual' },
    wait: { amount: 1, unit: 'days' },
    wait_for_reply: { amount: 1, unit: 'days' },
    condition: { kind: 'replied' },
    send_template: { template_name: '', language: 'en_US', params: [] },
    send_text: { text: '' },
    add_tag: { tag_id: '' },
    remove_tag: { tag_id: '' },
    create_deal: { pipeline_id: '', stage_id: '', title: 'Deal for {{name}}', value: 0 },
    end: {},
  };
  return structuredClone(defaults[type]);
}

export function newNode<T extends JourneyNodeType>(
  type: T,
  position = { x: 0, y: 0 },
  id: string = `n_${Math.random().toString(36).slice(2, 10)}`
): JourneyNode<T> {
  return { id, type, config: defaultConfig(type), next: {}, position };
}

/** A starter graph: trigger → end. */
export function starterGraph(): JourneyGraph {
  const end = newNode('end', { x: 0, y: 220 }, 'end');
  const trigger = newNode('trigger', { x: 0, y: 0 }, 'trigger');
  trigger.next.next = end.id;
  return { nodes: [trigger, end] };
}

export function durationMs(amount: number, unit: DurationUnit): number {
  const n = Math.max(0, Number(amount) || 0);
  return n * (unit === 'minutes' ? 60_000 : unit === 'hours' ? 3_600_000 : 86_400_000);
}

export function findTrigger(graph: JourneyGraph): JourneyNode<'trigger'> | null {
  return (graph.nodes.find((n) => n.type === 'trigger') as JourneyNode<'trigger'>) ?? null;
}

// ------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------

export interface GraphIssue {
  nodeId: string | null;
  message: string;
}

const MAX_NODES = 100;
const MAX_WAIT_MS = 90 * 86_400_000;

export function validateGraph(graph: unknown): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const g = graph as JourneyGraph;
  if (!g || !Array.isArray(g.nodes)) return [{ nodeId: null, message: 'Graph has no nodes' }];
  if (g.nodes.length > MAX_NODES) issues.push({ nodeId: null, message: `At most ${MAX_NODES} steps` });

  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== 'string' || !n.id) {
      issues.push({ nodeId: null, message: 'A step has no id' });
      continue;
    }
    if (ids.has(n.id)) issues.push({ nodeId: n.id, message: 'Duplicate step id' });
    ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) issues.push({ nodeId: n.id, message: `Unknown step type "${String(n.type)}"` });
  }

  const triggers = g.nodes.filter((n) => n?.type === 'trigger');
  if (triggers.length !== 1) issues.push({ nodeId: null, message: 'A journey needs exactly one trigger' });

  for (const n of g.nodes) {
    if (!n || !NODE_TYPES.includes(n.type)) continue;
    for (const slot of slotsFor(n.type)) {
      const target = n.next?.[slot];
      if (!target) issues.push({ nodeId: n.id, message: `"${slot}" is not connected` });
      else if (!ids.has(target)) issues.push({ nodeId: n.id, message: `"${slot}" points to a missing step` });
      else if (target === n.id) issues.push({ nodeId: n.id, message: 'A step cannot connect to itself' });
    }
    issues.push(...configIssues(n));
  }

  // Every step should be reachable from the trigger.
  if (triggers.length === 1) {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const seen = new Set<string>();
    const stack = [triggers[0].id];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const t of Object.values(byId.get(id)?.next ?? {})) if (t) stack.push(t);
    }
    for (const n of g.nodes) {
      if (n?.id && !seen.has(n.id)) issues.push({ nodeId: n.id, message: 'Not reachable from the trigger' });
    }
  }

  // A loop with no wait would spin forever.
  for (const cycle of waitlessCycles(g)) {
    issues.push({ nodeId: cycle, message: 'This step is in a loop with no wait in it' });
  }
  return issues;
}

function configIssues(n: JourneyNode): GraphIssue[] {
  const out: GraphIssue[] = [];
  const bad = (message: string) => out.push({ nodeId: n.id, message });
  const c = (n.config ?? {}) as Record<string, unknown>;
  switch (n.type) {
    case 'trigger': {
      const t = c.trigger_type as string;
      if (!TRIGGER_TYPES.includes(t as JourneyTriggerType)) bad('Choose what starts the journey');
      if (t === 'tag_added' && !c.tag_id) bad('Choose the tag that starts the journey');
      break;
    }
    case 'wait':
    case 'wait_for_reply': {
      const ms = durationMs(Number(c.amount), c.unit as DurationUnit);
      if (!['minutes', 'hours', 'days'].includes(c.unit as string) || ms <= 0) bad('Set how long to wait');
      else if (ms > MAX_WAIT_MS) bad('Waits are limited to 90 days');
      break;
    }
    case 'condition':
      if (!['has_tag', 'clicked_button', 'replied', 'window_open'].includes(c.kind as string)) bad('Choose a condition');
      if (c.kind === 'has_tag' && !c.tag_id) bad('Choose a tag');
      break;
    case 'send_template':
      if (!String(c.template_name ?? '').trim()) bad('Choose a template');
      break;
    case 'send_text':
      if (!String(c.text ?? '').trim()) bad('Write the message');
      else if (String(c.text).length > 4096) bad('Message is too long (4096 max)');
      break;
    case 'add_tag':
    case 'remove_tag':
      if (!c.tag_id) bad('Choose a tag');
      break;
    case 'create_deal':
      if (!c.pipeline_id || !c.stage_id) bad('Choose a pipeline and stage');
      break;
  }
  return out;
}

/** Ids of nodes that sit on a cycle containing no wait step. */
function waitlessCycles(g: JourneyGraph): string[] {
  const byId = new Map(g.nodes.filter((n) => n?.id).map((n) => [n.id, n]));
  const isWait = (n?: JourneyNode) => n?.type === 'wait' || n?.type === 'wait_for_reply';
  const flagged = new Set<string>();
  // DFS over the subgraph of non-wait nodes only.
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string) => {
    state.set(id, 'visiting');
    path.push(id);
    for (const t of Object.values(byId.get(id)?.next ?? {})) {
      if (!t || isWait(byId.get(t)) || !byId.has(t)) continue;
      if (state.get(t) === 'visiting') {
        for (const p of path.slice(path.indexOf(t))) flagged.add(p);
      } else if (!state.has(t)) visit(t);
    }
    path.pop();
    state.set(id, 'done');
  };
  for (const n of byId.values()) if (!isWait(n) && !state.has(n.id)) visit(n.id);
  return [...flagged];
}
