// ============================================================
// Journey graph model (migrations 050, 054). Pure — shared by the
// canvas editor (browser), the API (validation on save/activate) and
// the engine (server).
//
// A graph is a list of nodes. Each node names its outgoing
// connections in `next`, keyed by slot: most nodes have one slot
// ("next"); branching nodes have more (condition: yes/no, wait for
// reply: replied/timeout, switch: one per case + default, loop:
// each/done, http/code: success/error). Keeping edges inside nodes
// means there is no separate edge list to drift out of sync.
//
// Since 054 steps pass data along n8n-style: every step's output is
// kept on the enrollment and any text field can reference it with
// {{ … }} expressions (see ./expressions).
// ============================================================

export type JourneyTriggerType =
  | 'manual'
  | 'contact_created'
  | 'first_message'
  | 'tag_added'
  | 'button_clicked'
  | 'inbound_message'
  | 'webhook'
  | 'schedule';

export const TRIGGER_TYPES: JourneyTriggerType[] = [
  'manual',
  'contact_created',
  'first_message',
  'inbound_message',
  'tag_added',
  'button_clicked',
  'webhook',
  'schedule',
];

export type DurationUnit = 'minutes' | 'hours' | 'days';

export type ConditionKind = 'has_tag' | 'clicked_button' | 'replied' | 'window_open' | 'expression';

export const CONDITION_KINDS: ConditionKind[] = ['replied', 'clicked_button', 'has_tag', 'window_open', 'expression'];

/** Comparison operators for expression conditions and switch cases. */
export type CompareOp =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_empty'
  | 'not_empty'
  | 'regex';

export const COMPARE_OPS: CompareOp[] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_empty',
  'not_empty',
  'regex',
];

/** Operators that take no right-hand value. */
export const UNARY_OPS: CompareOp[] = ['is_empty', 'not_empty'];

export type ScheduleMode = 'interval' | 'daily' | 'weekly';

export interface ScheduleConfig {
  mode: ScheduleMode;
  /** interval: run every `every` `unit`. */
  every?: number;
  unit?: 'minutes' | 'hours';
  /** daily / weekly: local time "HH:MM" in `timezone`. */
  time?: string;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  days?: number[];
  timezone?: string;
}

export interface TriggerConfig extends Partial<ScheduleConfig> {
  trigger_type: JourneyTriggerType;
  /** tag_added; schedule audience. */
  tag_id?: string;
  /** button_clicked. */
  button_text?: string;
  /** inbound_message: empty = any message. */
  keyword?: string;
  match_type?: 'contains' | 'exact';
  /** webhook: where to find the customer in the payload. */
  phone?: string;
  name?: string;
  /** webhook: prefix for national numbers without a country code, e.g. "91". */
  default_country_code?: string;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export interface KeyValue {
  key: string;
  value: string;
}

export interface NodeConfigs {
  trigger: TriggerConfig;
  /** `until`: optional expression → date/time to resume at; amount/unit is the fallback. */
  wait: { amount: number; unit: DurationUnit; until?: string };
  wait_for_reply: { amount: number; unit: DurationUnit };
  condition: {
    kind: ConditionKind;
    tag_id?: string;
    button_text?: string;
    /** kind 'expression'. */
    left?: string;
    op?: CompareOp;
    right?: string;
  };
  switch: { value: string; cases: { op: CompareOp; value: string; label?: string }[] };
  loop: { items: string; max?: number };
  set_variable: { assignments: KeyValue[] };
  http_request: {
    method: HttpMethod;
    url: string;
    headers: KeyValue[];
    query: KeyValue[];
    body_type: 'none' | 'json' | 'form' | 'raw';
    body: string;
    form: KeyValue[];
    timeout_s?: number;
  };
  code: { code: string };
  send_template: { template_name: string; language?: string; params?: string[] };
  send_text: { text: string };
  send_media: { media_type: 'image' | 'video' | 'document'; url: string; caption?: string; filename?: string };
  send_buttons: { text: string; header?: string; footer?: string; buttons: { title: string }[] };
  add_tag: { tag_id: string };
  remove_tag: { tag_id: string };
  update_contact: { fields: KeyValue[] };
  conversation: { action: 'assign' | 'close' | 'reopen'; user_id?: string };
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
  /** Optional display name (defaults to the step type's name). */
  label?: string;
}

export interface JourneyGraph {
  nodes: JourneyNode[];
}

export const NODE_TYPES: JourneyNodeType[] = [
  'trigger',
  'wait',
  'wait_for_reply',
  'condition',
  'switch',
  'loop',
  'set_variable',
  'http_request',
  'code',
  'send_template',
  'send_text',
  'send_media',
  'send_buttons',
  'add_tag',
  'remove_tag',
  'update_contact',
  'conversation',
  'create_deal',
  'end',
];

/** Fields update_contact may write (custom fields are `custom:<id>`). */
export const CONTACT_FIELDS = ['name', 'email', 'company'] as const;

/**
 * Outgoing slots, in display order. Accepts a node (switch slots come
 * from its cases) or just a type.
 */
export function slotsFor(nodeOrType: JourneyNodeType | Pick<JourneyNode, 'type' | 'config'>): string[] {
  const type = typeof nodeOrType === 'string' ? nodeOrType : nodeOrType.type;
  switch (type) {
    case 'condition':
      return ['yes', 'no'];
    case 'wait_for_reply':
      return ['replied', 'timeout'];
    case 'switch': {
      const cases =
        typeof nodeOrType === 'string' ? [] : ((nodeOrType.config as NodeConfigs['switch']).cases ?? []);
      return [...cases.map((_, i) => `case_${i}`), 'default'];
    }
    case 'loop':
      return ['each', 'done'];
    case 'http_request':
    case 'code':
      return ['success', 'error'];
    case 'end':
      return [];
    default:
      return ['next'];
  }
}

/**
 * Slots that may stay unconnected. Taking one at run time fails the
 * step with its error — like n8n without "continue on fail".
 */
export function isOptionalSlot(type: JourneyNodeType, slot: string): boolean {
  return (type === 'http_request' || type === 'code') && slot === 'error';
}

export function defaultConfig<T extends JourneyNodeType>(type: T): NodeConfigs[T] {
  const defaults: { [K in JourneyNodeType]: NodeConfigs[K] } = {
    trigger: { trigger_type: 'manual' },
    wait: { amount: 1, unit: 'days' },
    wait_for_reply: { amount: 1, unit: 'days' },
    condition: { kind: 'replied' },
    switch: { value: '{{ reply.text }}', cases: [{ op: 'equals', value: '' }] },
    loop: { items: '', max: 50 },
    set_variable: { assignments: [{ key: '', value: '' }] },
    http_request: {
      method: 'GET',
      url: '',
      headers: [],
      query: [],
      body_type: 'none',
      body: '',
      form: [],
      timeout_s: 15,
    },
    code: {
      code:
        '// $input has: contact, trigger, nodes, vars, reply, item, index\n' +
        '// Return any JSON value — later steps read it as {{ nodes.<this step id>.… }}.\n' +
        'return { greeting: `Hi ${contact.name || "there"}` };',
    },
    send_template: { template_name: '', language: 'en_US', params: [] },
    send_text: { text: '' },
    send_media: { media_type: 'image', url: '', caption: '' },
    send_buttons: { text: '', buttons: [{ title: '' }] },
    add_tag: { tag_id: '' },
    remove_tag: { tag_id: '' },
    update_contact: { fields: [{ key: 'name', value: '' }] },
    conversation: { action: 'close' },
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
export const MAX_LOOP_ITEMS = 100;
export const MIN_SCHEDULE_MINUTES = 5;
const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
    for (const slot of slotsFor(n)) {
      const target = n.next?.[slot];
      if (!target) {
        if (!isOptionalSlot(n.type, slot)) issues.push({ nodeId: n.id, message: `"${slot}" is not connected` });
      } else if (!ids.has(target)) issues.push({ nodeId: n.id, message: `"${slot}" points to a missing step` });
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

function nonEmpty(v: unknown): boolean {
  return String(v ?? '').trim().length > 0;
}

function configIssues(n: JourneyNode): GraphIssue[] {
  const out: GraphIssue[] = [];
  const bad = (message: string) => out.push({ nodeId: n.id, message });
  const c = (n.config ?? {}) as Record<string, unknown>;
  switch (n.type) {
    case 'trigger': {
      const cfg = c as unknown as TriggerConfig;
      const t = cfg.trigger_type;
      if (!TRIGGER_TYPES.includes(t)) bad('Choose what starts the journey');
      if (t === 'tag_added' && !cfg.tag_id) bad('Choose the tag that starts the journey');
      if (t === 'webhook' && !nonEmpty(cfg.phone)) bad('Map the customer phone number from the webhook data');
      if (t === 'webhook' && cfg.default_country_code && !/^\d{1,4}$/.test(cfg.default_country_code)) {
        bad('Default country code must be 1–4 digits, e.g. 91');
      }
      if (t === 'schedule') out.push(...scheduleIssues(n.id, cfg));
      break;
    }
    case 'wait':
    case 'wait_for_reply': {
      const ms = durationMs(Number(c.amount), c.unit as DurationUnit);
      if (!['minutes', 'hours', 'days'].includes(c.unit as string) || ms <= 0) bad('Set how long to wait');
      else if (ms > MAX_WAIT_MS) bad('Waits are limited to 90 days');
      break;
    }
    case 'condition': {
      const cfg = c as NodeConfigs['condition'];
      if (!CONDITION_KINDS.includes(cfg.kind)) bad('Choose a condition');
      if (cfg.kind === 'has_tag' && !cfg.tag_id) bad('Choose a tag');
      if (cfg.kind === 'expression') {
        if (!nonEmpty(cfg.left)) bad('Set the value to check');
        if (!COMPARE_OPS.includes(cfg.op as CompareOp)) bad('Choose a comparison');
        if (cfg.op === 'regex') out.push(...regexIssue(n.id, cfg.right));
      }
      break;
    }
    case 'switch': {
      const cfg = c as NodeConfigs['switch'];
      if (!nonEmpty(cfg.value)) bad('Set the value to route on');
      if (!Array.isArray(cfg.cases) || cfg.cases.length === 0) bad('Add at least one case');
      else if (cfg.cases.length > 10) bad('At most 10 cases');
      for (const k of cfg.cases ?? []) {
        if (!COMPARE_OPS.includes(k.op)) bad('Every case needs a comparison');
        if (k.op === 'regex') out.push(...regexIssue(n.id, k.value));
      }
      break;
    }
    case 'loop': {
      const cfg = c as NodeConfigs['loop'];
      if (!nonEmpty(cfg.items)) bad('Choose the list to loop over, e.g. {{ nodes.step.body.items }}');
      const max = Number(cfg.max ?? MAX_LOOP_ITEMS);
      if (!Number.isInteger(max) || max < 1 || max > MAX_LOOP_ITEMS) bad(`Loop limit must be 1–${MAX_LOOP_ITEMS}`);
      break;
    }
    case 'set_variable': {
      const cfg = c as NodeConfigs['set_variable'];
      if (!Array.isArray(cfg.assignments) || cfg.assignments.length === 0) bad('Add a variable');
      for (const a of cfg.assignments ?? []) {
        if (!VAR_KEY_RE.test(a.key ?? '')) bad(`"${a.key ?? ''}" is not a valid variable name (letters, digits, _)`);
      }
      break;
    }
    case 'http_request': {
      const cfg = c as NodeConfigs['http_request'];
      if (!HTTP_METHODS.includes(cfg.method)) bad('Choose a method');
      const url = String(cfg.url ?? '').trim();
      if (!url) bad('Enter the URL');
      else if (!/^https?:\/\//i.test(url) && !url.startsWith('{{')) bad('URL must start with http:// or https://');
      const timeout = Number(cfg.timeout_s ?? 15);
      if (!(timeout >= 1 && timeout <= 30)) bad('Timeout must be 1–30 seconds');
      for (const h of cfg.headers ?? []) if (!nonEmpty(h.key)) bad('Every header needs a name');
      break;
    }
    case 'code':
      if (!nonEmpty(c.code)) bad('Write some code');
      else if (String(c.code).length > 20_000) bad('Code is too long (20 000 characters max)');
      break;
    case 'send_template':
      if (!nonEmpty(c.template_name)) bad('Choose a template');
      break;
    case 'send_text':
      if (!nonEmpty(c.text)) bad('Write the message');
      else if (String(c.text).length > 4096) bad('Message is too long (4096 max)');
      break;
    case 'send_media': {
      const cfg = c as NodeConfigs['send_media'];
      if (!['image', 'video', 'document'].includes(cfg.media_type)) bad('Choose the media type');
      if (!nonEmpty(cfg.url)) bad('Enter the media URL');
      if ((cfg.caption ?? '').length > 1024) bad('Caption is too long (1024 max)');
      break;
    }
    case 'send_buttons': {
      const cfg = c as NodeConfigs['send_buttons'];
      if (!nonEmpty(cfg.text)) bad('Write the message');
      const buttons = cfg.buttons ?? [];
      if (buttons.length < 1 || buttons.length > 3) bad('Add 1–3 buttons');
      for (const b of buttons) {
        if (!nonEmpty(b.title)) bad('Every button needs a title');
        else if (b.title.length > 20 && !b.title.includes('{{')) bad(`"${b.title}" is longer than 20 characters`);
      }
      break;
    }
    case 'add_tag':
    case 'remove_tag':
      if (!c.tag_id) bad('Choose a tag');
      break;
    case 'update_contact': {
      const cfg = c as NodeConfigs['update_contact'];
      if (!Array.isArray(cfg.fields) || cfg.fields.length === 0) bad('Choose a field to update');
      for (const f of cfg.fields ?? []) {
        const ok = (CONTACT_FIELDS as readonly string[]).includes(f.key) || /^custom:[0-9a-f-]{36}$/i.test(f.key ?? '');
        if (!ok) bad('Choose a field to update');
      }
      break;
    }
    case 'conversation': {
      const cfg = c as NodeConfigs['conversation'];
      if (!['assign', 'close', 'reopen'].includes(cfg.action)) bad('Choose what to do with the conversation');
      if (cfg.action === 'assign' && !cfg.user_id) bad('Choose a team member');
      break;
    }
    case 'create_deal':
      if (!c.pipeline_id || !c.stage_id) bad('Choose a pipeline and stage');
      break;
  }
  return out;
}

function regexIssue(nodeId: string, pattern: unknown): GraphIssue[] {
  const p = String(pattern ?? '');
  if (p.includes('{{')) return [];
  try {
    new RegExp(p);
    return [];
  } catch {
    return [{ nodeId, message: `"${p}" is not a valid regular expression` }];
  }
}

function scheduleIssues(nodeId: string, cfg: TriggerConfig): GraphIssue[] {
  const out: GraphIssue[] = [];
  const bad = (message: string) => out.push({ nodeId, message });
  if (!cfg.tag_id) bad('Choose which contacts (tag) the schedule runs for');
  if (cfg.mode === 'interval') {
    const every = Number(cfg.every);
    const minutes = cfg.unit === 'hours' ? every * 60 : every;
    if (!Number.isInteger(every) || every < 1) bad('Set how often to run');
    else if (minutes < MIN_SCHEDULE_MINUTES) bad(`Run at most every ${MIN_SCHEDULE_MINUTES} minutes`);
  } else if (cfg.mode === 'daily' || cfg.mode === 'weekly') {
    if (!TIME_RE.test(cfg.time ?? '')) bad('Set the time (HH:MM)');
    if (cfg.mode === 'weekly' && !(cfg.days ?? []).some((d) => d >= 0 && d <= 6)) bad('Choose at least one day');
  } else {
    bad('Choose how often to run');
  }
  if (cfg.timezone && !isValidTimezone(cfg.timezone)) bad(`Unknown timezone "${cfg.timezone}"`);
  return out;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ids of nodes that sit on a cycle containing no wait step. A loop
 * step also breaks a cycle: its "each" branch runs at most `max` times.
 */
function waitlessCycles(g: JourneyGraph): string[] {
  const byId = new Map(g.nodes.filter((n) => n?.id).map((n) => [n.id, n]));
  const breaks = (n?: JourneyNode) => n?.type === 'wait' || n?.type === 'wait_for_reply' || n?.type === 'loop';
  const flagged = new Set<string>();
  // DFS over the subgraph of non-breaking nodes only.
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string) => {
    state.set(id, 'visiting');
    path.push(id);
    for (const t of Object.values(byId.get(id)?.next ?? {})) {
      if (!t || breaks(byId.get(t)) || !byId.has(t)) continue;
      if (state.get(t) === 'visiting') {
        for (const p of path.slice(path.indexOf(t))) flagged.add(p);
      } else if (!state.has(t)) visit(t);
    }
    path.pop();
    state.set(id, 'done');
  };
  for (const n of byId.values()) if (!breaks(n) && !state.has(n.id)) visit(n.id);
  return [...flagged];
}
