// ============================================================
// Deterministic Google-side identifiers.
//
// Every Scheduler job and Cloud Task is named from (broadcastId,
// schedule_version[, pass]). Creating the same one twice returns
// ALREADY_EXISTS, which the client treats as success — so a retried
// HTTP call, a double-click, or the reconciler re-arming a row can
// never produce a second trigger.
//
// The version is part of the name because Cloud Tasks reserves a task
// name for up to ~9 days after it is deleted or executed: a reschedule
// reusing the old name would be rejected.
//
// A short hash prefix spreads names across Cloud Tasks' key space;
// Google recommends against sequential/shared prefixes, which hotspot.
// ============================================================

import { createHash } from 'crypto';

function prefix(broadcastId: string): string {
  return createHash('sha256').update(broadcastId).digest('hex').slice(0, 8);
}

function clean(broadcastId: string): string {
  return broadcastId.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/** Short Cloud Scheduler job id (not the full resource name). */
export function schedulerJobId(broadcastId: string, version: number): string {
  return `bc-${clean(broadcastId)}-v${version}`;
}

/**
 * Short Cloud Tasks task id. `pass` 0 is the scheduled send; later
 * passes are continuations of a large broadcast. `suffix` makes the
 * reconciler's recovery tasks distinct from the originals.
 */
export function cloudTaskId(
  broadcastId: string,
  version: number,
  pass: number,
  suffix?: string
): string {
  const base = `${prefix(broadcastId)}-bc-${clean(broadcastId)}-v${version}-p${pass}`;
  return suffix ? `${base}-${suffix.replace(/[^A-Za-z0-9_-]/g, '')}` : base;
}

/** Last path segment of a full resource name, or the input unchanged. */
export function shortName(resourceName: string): string {
  const i = resourceName.lastIndexOf('/');
  return i === -1 ? resourceName : resourceName.slice(i + 1);
}
