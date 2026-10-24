// Shared helpers for the /api/journeys routes (migrations 050, 054).

import { randomBytes } from 'node:crypto';

import { findTrigger, validateGraph, type JourneyGraph, type JourneyTriggerType } from './graph';
import { nextScheduleTime } from './schedule';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Denormalised trigger columns, taken from the graph's trigger node. */
export function triggerColumns(graph: JourneyGraph): {
  trigger_type: JourneyTriggerType;
  trigger_config: Record<string, unknown>;
} {
  const t = findTrigger(graph);
  const cfg = t?.config ?? { trigger_type: 'manual' as const };
  const trigger_config: Record<string, unknown> = {};
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const put = (key: string, v: unknown) => {
    if (v !== undefined) trigger_config[key] = v;
  };
  switch (cfg.trigger_type) {
    case 'contact_created':
      put('contact_source', cfg.contact_source === 'api' || cfg.contact_source === 'whatsapp' ? cfg.contact_source : undefined);
      break;
    case 'tag_added':
      put('tag_id', str(cfg.tag_id));
      break;
    case 'button_clicked':
      put('button_text', str(cfg.button_text));
      break;
    case 'inbound_message':
      put('keyword', str(cfg.keyword));
      put('match_type', cfg.match_type === 'exact' ? 'exact' : undefined);
      break;
    case 'webhook':
      put('phone', str(cfg.phone));
      put('name', str(cfg.name));
      put('default_country_code', str(cfg.default_country_code));
      break;
    case 'schedule':
      put('tag_id', str(cfg.tag_id));
      put('mode', cfg.mode);
      put('every', cfg.every);
      put('unit', cfg.unit);
      put('time', str(cfg.time));
      put('days', Array.isArray(cfg.days) ? cfg.days : undefined);
      put('timezone', str(cfg.timezone));
      break;
  }
  return { trigger_type: cfg.trigger_type ?? 'manual', trigger_config };
}

/** next_scheduled_at for an active schedule journey; null otherwise. */
export function scheduleColumn(graph: JourneyGraph, status: string, now = new Date()): { next_scheduled_at: string | null } {
  const cfg = findTrigger(graph)?.config;
  if (status !== 'active' || cfg?.trigger_type !== 'schedule') return { next_scheduled_at: null };
  return { next_scheduled_at: nextScheduleTime(cfg, now)?.toISOString() ?? null };
}

/** Secret path segment for /api/journeys/hooks/<token>. */
export function newWebhookToken(): string {
  return randomBytes(24).toString('base64url');
}

export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

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
    JSON.stringify(g).length <= 512 * 1024 &&
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
