// Shared helpers for the /api/journeys routes (migration 050).

import { findTrigger, validateGraph, type JourneyGraph, type JourneyTriggerType } from './graph';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Denormalised trigger columns, taken from the graph's trigger node. */
export function triggerColumns(graph: JourneyGraph): {
  trigger_type: JourneyTriggerType;
  trigger_config: Record<string, string>;
} {
  const t = findTrigger(graph);
  const cfg = t?.config ?? { trigger_type: 'manual' as const };
  const trigger_config: Record<string, string> = {};
  if (cfg.trigger_type === 'tag_added' && cfg.tag_id) trigger_config.tag_id = cfg.tag_id;
  if (cfg.trigger_type === 'button_clicked' && cfg.button_text?.trim()) {
    trigger_config.button_text = cfg.button_text.trim();
  }
  return { trigger_type: cfg.trigger_type ?? 'manual', trigger_config };
}

/**
 * Cheap structural check for saving a draft (the full validateGraph
 * runs on activation, and on save while the journey is active).
 */
export function isGraphShape(graph: unknown): graph is JourneyGraph {
  const g = graph as JourneyGraph;
  return (
    !!g &&
    Array.isArray(g.nodes) &&
    g.nodes.length <= 100 &&
    g.nodes.every(
      (n) =>
        n &&
        typeof n.id === 'string' &&
        typeof n.type === 'string' &&
        typeof n.config === 'object' &&
        typeof n.next === 'object' &&
        n.position &&
        Number.isFinite(n.position.x) &&
        Number.isFinite(n.position.y)
    )
  );
}

export { validateGraph };
