// ============================================================
// Cloud Functions (2nd gen, Node 22) for scheduled broadcasts.
//
//   armBroadcast        ← Cloud Scheduler (T-2 min, one job per broadcast)
//   executeBroadcast    ← Cloud Tasks (exactly T, plus continuations)
//   reconcileBroadcasts ← Cloud Scheduler (*/5 min safety net)
//
// All three are deployed with --no-allow-unauthenticated: Cloud Run
// verifies the caller's Google-signed OIDC token and only the invoker
// service account holds roles/run.invoker. The optional shared-secret
// header is defence in depth on top of that.
//
//   windowKeepalive     ← Cloud Scheduler (*/5 min) — 24h-window check-ins
//
// Plain exported (req, res) handlers — the Node runtime wraps them in
// the Functions Framework automatically, so no runtime dependency.
// Bundled with esbuild from the app's own src/ (see build.mjs).
// ============================================================

import { timingSafeEqual } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  readSchedulingConfig,
  SCHEDULER_SECRET_HEADER,
  type SchedulingConfig,
} from '@/lib/broadcast-scheduling/config';
import { createGcpBackend, type SchedulingBackend } from '@/lib/broadcast-scheduling/gcp-backend';
import {
  handleArm,
  handleExecute,
  handleReconcile,
  isArmPayload,
  isExecutePayload,
  type HandlerOutcome,
} from '@/lib/broadcast-scheduling/execute';
import { runWindowKeepalive } from '@/lib/conversations/window-keepalive';

// Shared app modules (flows/ai admin clients used by engineSendText)
// read the Next.js variable name.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL;

interface Req {
  method?: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
}

let services: { db: SupabaseClient; cfg: SchedulingConfig; backend: SchedulingBackend } | null =
  null;

function getServices() {
  if (!services) {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    const cfg = readSchedulingConfig();
    services = {
      db: createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }),
      cfg,
      backend: createGcpBackend(cfg),
    };
  }
  return services;
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function secretOk(req: Req, expected: string | null): boolean {
  if (!expected) return true;
  const got = Buffer.from(header(req, SCHEDULER_SECRET_HEADER) ?? '');
  const want = Buffer.from(expected);
  return got.length === want.length && timingSafeEqual(got, want);
}

function parseBody(req: Req): unknown {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch {
      return null;
    }
  }
  return req.body;
}

/**
 * HTTP status per outcome. Only 'busy' and thrown errors are non-2xx:
 * those are the cases where Cloud Tasks / Scheduler SHOULD retry.
 * Skips are 200 so a stale trigger is acknowledged and dropped.
 */
function send(res: Res, result: HandlerOutcome) {
  res.status(result.outcome === 'busy' ? 503 : 200).json(result);
}

function guard(req: Req, res: Res): ReturnType<typeof getServices> | null {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return null;
  }
  const s = getServices();
  if (!secretOk(req, s.cfg.sharedSecret)) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  return s;
}

export async function armBroadcast(req: Req, res: Res): Promise<void> {
  try {
    const s = guard(req, res);
    if (!s) return;
    const payload = parseBody(req);
    if (!isArmPayload(payload)) {
      res.status(400).json({ error: 'expected { broadcastId, version }' });
      return;
    }
    const result = await handleArm(s.db, s.backend, s.cfg, payload);
    console.log(JSON.stringify({ fn: 'armBroadcast', ...payload, ...result }));
    send(res, result);
  } catch (err) {
    console.error('[armBroadcast]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal' });
  }
}

export async function executeBroadcast(req: Req, res: Res): Promise<void> {
  try {
    const s = guard(req, res);
    if (!s) return;
    const payload = parseBody(req);
    if (!isExecutePayload(payload)) {
      // 200, not 400: a malformed task will never become well-formed,
      // and a 4xx would just be retried by Cloud Tasks until max-attempts.
      res.status(200).json({ outcome: 'skipped', reason: 'bad_payload' });
      return;
    }
    const retryCount = Number(header(req, 'x-cloudtasks-taskretrycount') ?? 0) || 0;
    const result = await handleExecute(s.db, s.backend, s.cfg, payload, { retryCount });
    console.log(JSON.stringify({ fn: 'executeBroadcast', ...payload, retryCount, ...result }));
    send(res, result);
  } catch (err) {
    console.error('[executeBroadcast]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal' });
  }
}

export async function reconcileBroadcasts(req: Req, res: Res): Promise<void> {
  try {
    const s = guard(req, res);
    if (!s) return;
    const report = await handleReconcile(s.db, s.backend, s.cfg);
    console.log(JSON.stringify({ fn: 'reconcileBroadcasts', ...report }));
    res.status(200).json(report);
  } catch (err) {
    console.error('[reconcileBroadcasts]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal' });
  }
}

export async function windowKeepalive(req: Req, res: Res): Promise<void> {
  try {
    const s = guard(req, res);
    if (!s) return;
    const report = await runWindowKeepalive(s.db);
    console.log(JSON.stringify({ fn: 'windowKeepalive', ...report }));
    res.status(200).json(report);
  } catch (err) {
    console.error('[windowKeepalive]', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal' });
  }
}
