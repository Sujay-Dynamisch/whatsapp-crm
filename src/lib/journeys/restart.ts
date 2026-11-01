// ============================================================
// Starting a contact's journey again part-way (callback follow-ups,
// a closed-lost lead writing back): the new run carries the last run's
// variables (links, texts…) and the outputs of steps it won't re-run;
// outputs of steps ahead of the start are dropped so they are recomputed.
// Pure.
// ============================================================

import type { JourneyGraph } from './graph';

/** Ids of the steps reachable from `start` (their old outputs would be stale). */
export function reachableFrom(graph: JourneyGraph, start: string): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const t of Object.values(byId.get(id)!.next ?? {})) if (t) stack.push(t);
  }
  return seen;
}

/** vars + still-valid node outputs of `previous` for a run starting at `startAt`. */
export function carriedContext(
  graph: JourneyGraph,
  previous: Record<string, unknown> | null | undefined,
  startAt: string
): { vars: Record<string, unknown>; nodes: Record<string, unknown> } {
  const prev = (previous ?? {}) as { vars?: Record<string, unknown>; nodes?: Record<string, unknown> };
  const ahead = reachableFrom(graph, startAt);
  return {
    vars: { ...(prev.vars ?? {}) },
    nodes: Object.fromEntries(Object.entries(prev.nodes ?? {}).filter(([id]) => !ahead.has(id))),
  };
}
