// ============================================================
// "Insert variable" suggestions for the journey editor (migration 054).
// Pure. Lists what a step can reference: the contact, the trigger's
// data, and the outputs of steps that can run before it.
// ============================================================

import type { JourneyGraph, JourneyNode, NodeConfigs } from './graph';

export type VarGroup = 'contact' | 'trigger' | 'reply' | 'vars' | 'steps' | 'loop' | 'other';

export interface VarSuggestion {
  group: VarGroup;
  /** Expression path, inserted as `{{ path }}`. */
  path: string;
  /** Optional human hint (step name, field name). */
  hint?: string;
}

/** Steps that can run before `nodeId` (reverse reachability). */
export function upstreamNodes(graph: JourneyGraph, nodeId: string): JourneyNode[] {
  const parents = new Map<string, string[]>();
  for (const n of graph.nodes) {
    for (const target of Object.values(n.next ?? {})) {
      if (!target) continue;
      parents.set(target, [...(parents.get(target) ?? []), n.id]);
    }
  }
  const seen = new Set<string>();
  const stack = [...(parents.get(nodeId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(parents.get(id) ?? []));
  }
  return graph.nodes.filter((n) => seen.has(n.id) && n.id !== nodeId);
}

export function variableSuggestions(
  graph: JourneyGraph,
  nodeId: string,
  customFields: string[] = []
): VarSuggestion[] {
  const out: VarSuggestion[] = [
    { group: 'contact', path: 'contact.name' },
    { group: 'contact', path: 'contact.phone' },
    { group: 'contact', path: 'contact.email' },
    { group: 'contact', path: 'contact.company' },
    ...customFields.map((f) => ({
      group: 'contact' as const,
      path: /^[A-Za-z_$][\w$]*$/.test(f) ? `contact.custom.${f}` : `contact.custom["${f.replace(/"/g, '\\"')}"]`,
      hint: f,
    })),
  ];

  const trigger = graph.nodes.find((n) => n.type === 'trigger');
  const t = trigger?.config as NodeConfigs['trigger'] | undefined;
  switch (t?.trigger_type) {
    case 'webhook':
      out.push({ group: 'trigger', path: 'trigger.body' }, { group: 'trigger', path: 'trigger.query' });
      break;
    case 'inbound_message':
      out.push({ group: 'trigger', path: 'trigger.text' });
      break;
    case 'button_clicked':
      out.push({ group: 'trigger', path: 'trigger.button_text' });
      break;
    case 'tag_added':
      out.push({ group: 'trigger', path: 'trigger.tag_id' });
      break;
    case 'schedule':
      out.push({ group: 'trigger', path: 'trigger.scheduled_at' });
      break;
  }
  out.push({ group: 'trigger', path: 'trigger.type' });

  const upstream = upstreamNodes(graph, nodeId);
  const self = graph.nodes.find((n) => n.id === nodeId);
  const name = (n: JourneyNode) => n.label?.trim() || undefined;

  if (upstream.some((n) => n.type === 'wait_for_reply')) {
    out.push({ group: 'reply', path: 'reply.text' }, { group: 'reply', path: 'reply.button' });
  }

  // A step inside a loop body is downstream of the loop's "each".
  const inLoop = upstream.some((n) => n.type === 'loop') || self?.type === 'loop';
  if (inLoop) out.push({ group: 'loop', path: 'item' }, { group: 'loop', path: 'index' });

  const varKeys = new Set<string>();
  for (const n of upstream) {
    switch (n.type) {
      case 'set_variable':
        for (const a of (n.config as NodeConfigs['set_variable']).assignments ?? []) {
          if (a.key && !varKeys.has(a.key)) {
            varKeys.add(a.key);
            out.push({ group: 'vars', path: `vars.${a.key}`, hint: name(n) });
          }
        }
        break;
      case 'http_request':
        out.push(
          { group: 'steps', path: `nodes.${n.id}.body`, hint: name(n) ?? 'HTTP' },
          { group: 'steps', path: `nodes.${n.id}.status`, hint: name(n) ?? 'HTTP' }
        );
        break;
      case 'code':
        out.push({ group: 'steps', path: `nodes.${n.id}`, hint: name(n) ?? 'Code' });
        break;
      case 'switch':
        out.push({ group: 'steps', path: `nodes.${n.id}.value`, hint: name(n) ?? 'Switch' });
        break;
      case 'condition':
        if ((n.config as NodeConfigs['condition']).kind === 'expression') {
          out.push({ group: 'steps', path: `nodes.${n.id}.result`, hint: name(n) });
        }
        break;
      case 'loop':
        out.push({ group: 'steps', path: `nodes.${n.id}.count`, hint: name(n) ?? 'Loop' });
        break;
      case 'create_deal':
        out.push({ group: 'steps', path: `nodes.${n.id}.deal_id`, hint: name(n) });
        break;
    }
  }
  out.push({ group: 'other', path: 'now' });
  return out;
}
