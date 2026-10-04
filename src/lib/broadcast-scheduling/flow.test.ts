import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SchedulingConfig } from './config';
import type { CreateJobInput, CreateTaskInput, SchedulingBackend } from './gcp-backend';
import { cancelBroadcastSchedule, retryScheduledBroadcast, scheduleBroadcast, ScheduleError } from './schedule';
import type { ExecutePayload, ArmPayload } from './schedule';
import { handleArm, handleExecute, handleReconcile } from './execute';

// ============================================================
// In-memory Supabase: just the PostgREST surface the scheduling layer
// uses (eq / in / or / lt / lte / limit / maybeSingle / head counts /
// update…select). Enough to exercise the conditional-UPDATE guards for
// real rather than asserting on mock call shapes.
// ============================================================

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function orClause(clause: string): Pred {
  const [col, op, ...rest] = clause.split('.');
  const val = rest.join('.');
  if (op === 'is' && val === 'null') return (r) => r[col] === null || r[col] === undefined;
  if (op === 'in') {
    const list = val.replace(/^\(|\)$/g, '').split(',');
    return (r) => list.includes(String(r[col]));
  }
  if (op === 'lt') return (r) => r[col] !== null && String(r[col]) < val;
  if (op === 'eq') return (r) => String(r[col]) === val;
  throw new Error(`fake db: unsupported or-clause ${clause}`);
}

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const preds: Pred[] = [];
      let patch: Row | null = null;
      let returning = false;
      let head = false;
      let single = false;
      let limitN = Infinity;

      const run = () => {
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        if (patch) {
          for (const r of hit) Object.assign(r, patch);
          return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
        }
        if (head) return { data: null, count: hit.length, error: null };
        const data = hit.slice(0, limitN).map((r) => ({ ...r }));
        if (single) return { data: data[0] ?? null, error: null };
        return { data, error: null };
      };

      const b: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (patch) returning = true;
          if (opts?.head) head = true;
          return b;
        },
        update: (p: Row) => {
          patch = p;
          return b;
        },
        eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (preds.push((r) => vs.includes(r[c])), b),
        lt: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) < v), b),
        lte: (c: string, v: string) => (preds.push((r) => r[c] != null && String(r[c]) <= v), b),
        or: (expr: string) => {
          const clauses = splitTop(expr).map(orClause);
          preds.push((r) => clauses.some((p) => p(r)));
          return b;
        },
        limit: (n: number) => ((limitN = n), b),
        order: () => b,
        maybeSingle: () => ((single = true), b),
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

// ============================================================
// Delivery is the existing, separately-tested code. Here it is
// replaced by a stand-in that stamps planned recipients 'sent'.
// ============================================================

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  sends: [] as string[],
  failSendsWith: null as Error | null,
}));

vi.mock('@/lib/whatsapp/broadcast-resume', async (orig) => {
  const actual = await orig<typeof import('@/lib/whatsapp/broadcast-resume')>();
  const { BroadcastError } = await import('@/lib/whatsapp/broadcast-core');
  return {
    ...actual,
    planBroadcastResume: vi.fn(async (_db: unknown, _acct: string, id: string) => {
      if (state.failSendsWith) throw state.failSendsWith;
      const pending = state.tables.broadcast_recipients.filter(
        (r) => r.broadcast_id === id && r.status === 'pending'
      );
      if (pending.length === 0) throw new BroadcastError('nothing_to_resume', 'none', 400);
      return {
        plan: {
          broadcastId: id,
          planned: pending.map((r) => ({ recipientRowId: r.id, phone: '+1', params: [] })),
        },
        remaining: 0,
        unsendable: 0,
      };
    }),
  };
});

vi.mock('@/lib/whatsapp/broadcast-core', async (orig) => {
  const actual = await orig<typeof import('@/lib/whatsapp/broadcast-core')>();
  return {
    ...actual,
    deliverBroadcast: vi.fn(async (_db: unknown, plan: { planned: { recipientRowId: string }[] }) => {
      for (const p of plan.planned) {
        const r = state.tables.broadcast_recipients.find((x) => x.id === p.recipientRowId)!;
        r.status = 'sent';
        state.sends.push(p.recipientRowId);
      }
    }),
    finalizeBroadcastStatus: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/contacts/unsubscribe', () => ({
  getUnsubscribedContactIds: vi.fn(async () => new Set(['contact-unsub'])),
}));

// ============================================================
// Fake Google backend — records triggers, enforces name uniqueness
// the way Cloud Tasks / Scheduler do (ALREADY_EXISTS → same name).
// ============================================================

function fakeBackend() {
  const jobs = new Map<string, CreateJobInput>();
  const tasks = new Map<string, CreateTaskInput>();
  const deleted: string[] = [];
  const backend: SchedulingBackend = {
    async createSchedulerJob(i) {
      const name = `jobs/${i.jobId}`;
      if (!jobs.has(name)) jobs.set(name, i);
      return name;
    },
    async deleteSchedulerJob(name) {
      jobs.delete(name.replace(/^projects\/[^/]+\/locations\/[^/]+\//, ''));
      deleted.push(name);
    },
    async createTask(i) {
      const name = `tasks/${i.taskId}`;
      if (!tasks.has(name)) tasks.set(name, i);
      return name;
    },
    async deleteTask(name) {
      tasks.delete(name);
      deleted.push(name);
    },
  };
  return { backend, jobs, tasks, deleted };
}

const cfg: SchedulingConfig = {
  projectId: 'p',
  location: 'asia-south1',
  queue: 'q',
  armUrl: 'https://arm',
  executeUrl: 'https://exec',
  invokerServiceAccount: 'invoker@p.iam.gserviceaccount.com',
  sharedSecret: null,
  leadMs: 120_000,
  maxLatenessMs: 6 * 60 * 60_000,
  passSize: 500,
  taskMaxAttempts: 5,
};

const NOW = new Date('2026-10-04T06:00:00.000Z');
const AT = new Date('2026-10-05T04:00:00.000Z'); // 09:30 IST tomorrow
const BC = 'bc-1';

function seed(recipients = 3) {
  state.tables = {
    broadcasts: [
      {
        id: BC,
        account_id: 'acct',
        status: 'scheduled',
        scheduled_at: null,
        timezone: 'Asia/Kolkata',
        schedule_status: null,
        schedule_version: 0,
        scheduler_job_id: null,
        cloud_task_id: null,
        delivery_locked_at: null,
        execution_started_at: null,
        execution_attempts: 0,
        execution_result: null,
        updated_at: NOW.toISOString(),
      },
    ],
    broadcast_recipients: Array.from({ length: recipients }, (_, i) => ({
      id: `r${i}`,
      broadcast_id: BC,
      contact_id: `contact-${i}`,
      status: 'pending',
    })),
    tags: [],
    contact_tags: [],
  };
  state.sends = [];
  state.failSendsWith = null;
}

const row = () => state.tables.broadcasts[0];
const db = () => fakeDb(state.tables);

beforeEach(() => seed());

describe('scheduleBroadcast', () => {
  it('creates a Scheduler job for T-2min in the broadcast zone and bumps the version', async () => {
    const g = fakeBackend();
    const r = await scheduleBroadcast(db(), g.backend, cfg, {
      accountId: 'acct',
      broadcastId: BC,
      scheduledAt: AT,
      timezone: 'Asia/Kolkata',
      now: NOW,
    });

    expect(r.trigger).toBe('scheduler');
    expect(row().schedule_status).toBe('scheduled');
    expect(row().schedule_version).toBe(1);
    const job = [...g.jobs.values()][0];
    expect(job.cron).toBe('28 9 5 10 *');
    expect(job.timeZone).toBe('Asia/Kolkata');
    expect(job.payload).toEqual({ broadcastId: BC, version: 1 });
    expect(g.tasks.size).toBe(0);
  });

  it('goes straight to Cloud Tasks when the send is inside the lead window', async () => {
    const g = fakeBackend();
    const soon = new Date(NOW.getTime() + 90_000);
    const r = await scheduleBroadcast(db(), g.backend, cfg, {
      accountId: 'acct',
      broadcastId: BC,
      scheduledAt: soon,
      timezone: 'Asia/Kolkata',
      now: NOW,
    });
    expect(r.trigger).toBe('task');
    expect(row().schedule_status).toBe('queued');
    expect([...g.tasks.values()][0].scheduleTime.toISOString()).toBe(soon.toISOString());
    expect(g.jobs.size).toBe(0);
  });

  it('rejects past times, unknown zones and broadcasts with nothing pending', async () => {
    const g = fakeBackend();
    const base = { accountId: 'acct', broadcastId: BC, timezone: 'Asia/Kolkata', now: NOW };
    await expect(
      scheduleBroadcast(db(), g.backend, cfg, { ...base, scheduledAt: new Date(NOW.getTime() - 5 * 60_000) })
    ).rejects.toMatchObject({ code: 'schedule_in_past' });
    await expect(
      scheduleBroadcast(db(), g.backend, cfg, { ...base, scheduledAt: AT, timezone: 'Nope/Nope' })
    ).rejects.toMatchObject({ code: 'invalid_timezone' });

    seed(0);
    await expect(
      scheduleBroadcast(db(), g.backend, cfg, { ...base, scheduledAt: AT })
    ).rejects.toMatchObject({ code: 'no_pending_recipients' });
  });

  it('rescheduling deletes the old job, and the old job no-ops if it fires anyway', async () => {
    const g = fakeBackend();
    const base = { accountId: 'acct', broadcastId: BC, timezone: 'Asia/Kolkata', now: NOW };
    await scheduleBroadcast(db(), g.backend, cfg, { ...base, scheduledAt: AT });
    await scheduleBroadcast(db(), g.backend, cfg, {
      ...base,
      scheduledAt: new Date(AT.getTime() + 3600_000),
    });

    expect(row().schedule_version).toBe(2);
    expect(g.deleted).toContain('jobs/bc-bc-1-v1');
    expect([...g.jobs.keys()]).toEqual(['jobs/bc-bc-1-v2']);

    const stale = await handleArm(db(), g.backend, cfg, { broadcastId: BC, version: 1 }, AT);
    expect(stale).toEqual({ outcome: 'skipped', reason: 'stale_version' });
    expect(g.tasks.size).toBe(0);
  });

  it('refuses to reschedule once sending has started', async () => {
    row().schedule_status = 'processing';
    await expect(
      scheduleBroadcast(db(), fakeBackend().backend, cfg, {
        accountId: 'acct',
        broadcastId: BC,
        scheduledAt: AT,
        timezone: 'Asia/Kolkata',
        now: NOW,
      })
    ).rejects.toBeInstanceOf(ScheduleError);
  });
});

async function scheduledAndArmed(g = fakeBackend()) {
  await scheduleBroadcast(db(), g.backend, cfg, {
    accountId: 'acct',
    broadcastId: BC,
    scheduledAt: AT,
    timezone: 'Asia/Kolkata',
    now: NOW,
  });
  const armAt = new Date(AT.getTime() - 120_000);
  const armed = await handleArm(db(), g.backend, cfg, { broadcastId: BC, version: 1 } as ArmPayload, armAt);
  return { g, armed };
}

describe('arm → execute', () => {
  it('arm queues a task for exactly scheduled_at and removes its own job', async () => {
    const { g, armed } = await scheduledAndArmed();
    expect(armed.outcome).toBe('queued');
    expect(row().schedule_status).toBe('queued');
    const task = [...g.tasks.values()][0];
    expect(task.scheduleTime.toISOString()).toBe(AT.toISOString());
    expect(task.payload).toMatchObject({ broadcastId: BC, version: 1, pass: 0, trigger: 'schedule' });
    expect(g.jobs.size).toBe(0);
  });

  it('arming twice is idempotent (same deterministic task)', async () => {
    const { g } = await scheduledAndArmed();
    // Row is 'queued' now, so a duplicate Scheduler delivery is skipped.
    const again = await handleArm(db(), g.backend, cfg, { broadcastId: BC, version: 1 }, AT);
    expect(again.outcome).toBe('skipped');
    expect(g.tasks.size).toBe(1);
  });

  it('execute sends every pending recipient once and completes the row', async () => {
    const { g } = await scheduledAndArmed();
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;

    const res = await handleExecute(db(), g.backend, cfg, payload, { now: AT });
    expect(res).toEqual({ outcome: 'completed', sent: 3, failed: 0 });
    expect(row().schedule_status).toBe('completed');
    expect(row().delivery_locked_at).toBeNull();
    expect(row().execution_result).toMatchObject({ total: 3, sent: 3, pending: 0, passes: 1 });
    expect(state.sends).toEqual(['r0', 'r1', 'r2']);

    // A duplicate delivery of the same task is a no-op.
    const dup = await handleExecute(db(), g.backend, cfg, payload, { now: AT });
    expect(dup.outcome).toBe('skipped');
    expect(state.sends).toHaveLength(3);
  });

  it('a second invocation while the first holds the lock is told to retry (busy)', async () => {
    const { g } = await scheduledAndArmed();
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;
    row().schedule_status = 'processing';
    row().delivery_locked_at = AT.toISOString();

    const res = await handleExecute(db(), g.backend, cfg, payload, {
      now: new Date(AT.getTime() + 1000),
    });
    expect(res).toEqual({ outcome: 'busy' });
    expect(state.sends).toHaveLength(0);
  });

  it('stamps contacts who unsubscribed after scheduling as failed instead of messaging them', async () => {
    state.tables.broadcast_recipients[1].contact_id = 'contact-unsub';
    const { g } = await scheduledAndArmed();
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;

    const res = await handleExecute(db(), g.backend, cfg, payload, { now: AT });
    expect(res).toEqual({ outcome: 'completed', sent: 2, failed: 1 });
    expect(state.sends).toEqual(['r0', 'r2']);
  });

  it('splits a large broadcast into continuation passes', async () => {
    seed(5);
    const { g } = await scheduledAndArmed();
    const first = [...g.tasks.values()][0].payload as ExecutePayload;
    const small = { ...cfg, passSize: 2 };

    expect(await handleExecute(db(), g.backend, small, first, { now: AT })).toMatchObject({
      outcome: 'continued',
      nextPass: 1,
      pending: 3,
    });
    expect(row().delivery_locked_at).toBeNull();
    const next = [...g.tasks.values()].at(-1)!.payload as ExecutePayload;
    expect(next).toMatchObject({ pass: 1, trigger: 'continuation' });

    await handleExecute(db(), g.backend, small, next, { now: AT });
    const last = [...g.tasks.values()].at(-1)!.payload as ExecutePayload;
    expect(await handleExecute(db(), g.backend, small, last, { now: AT })).toMatchObject({
      outcome: 'completed',
      sent: 5,
    });
    expect(state.sends).toHaveLength(5);
    expect(new Set(state.sends).size).toBe(5);
  });

  it('fails a send that arrives beyond the lateness limit instead of sending it', async () => {
    const { g } = await scheduledAndArmed();
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;
    const res = await handleExecute(db(), g.backend, cfg, payload, {
      now: new Date(AT.getTime() + 7 * 3600_000),
    });
    expect(res.outcome).toBe('failed');
    expect(row().schedule_status).toBe('failed');
    expect(String(row().last_error)).toMatch(/^missed_schedule/);
    expect(state.sends).toHaveLength(0);
  });

  it('marks a configuration error failed without retrying', async () => {
    const { BroadcastError } = await import('@/lib/whatsapp/broadcast-core');
    const { g } = await scheduledAndArmed();
    state.failSendsWith = new BroadcastError('whatsapp_not_configured', 'no config', 400);
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;

    const res = await handleExecute(db(), g.backend, cfg, payload, { now: AT });
    expect(res.outcome).toBe('failed');
    expect(row().schedule_status).toBe('failed');
    expect(row().delivery_locked_at).toBeNull();
  });

  it('rethrows transient errors (so Cloud Tasks retries) and releases the lock', async () => {
    const { g } = await scheduledAndArmed();
    state.failSendsWith = new Error('ECONNRESET');
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;

    await expect(handleExecute(db(), g.backend, cfg, payload, { now: AT, retryCount: 0 })).rejects.toThrow(
      'ECONNRESET'
    );
    expect(row().schedule_status).toBe('processing');
    expect(row().delivery_locked_at).toBeNull();

    // …and the last attempt gives up visibly.
    const res = await handleExecute(db(), g.backend, cfg, payload, { now: AT, retryCount: 4 });
    expect(res.outcome).toBe('failed');
    expect(row().schedule_status).toBe('failed');
  });
});

describe('cancel and retry', () => {
  it('cancel deletes the trigger and turns any in-flight task into a no-op', async () => {
    const { g } = await scheduledAndArmed();
    const payload = [...g.tasks.values()][0].payload as ExecutePayload;

    await cancelBroadcastSchedule(db(), g.backend, { accountId: 'acct', broadcastId: BC, now: NOW });
    expect(row().schedule_status).toBe('cancelled');
    expect(row().status).toBe('cancelled');
    expect(g.tasks.size).toBe(0);

    const res = await handleExecute(db(), g.backend, cfg, payload, { now: AT });
    expect(res.outcome).toBe('skipped');
    expect(state.sends).toHaveLength(0);
  });

  it('cannot cancel once processing', async () => {
    row().schedule_status = 'processing';
    await expect(
      cancelBroadcastSchedule(db(), fakeBackend().backend, { accountId: 'acct', broadcastId: BC })
    ).rejects.toMatchObject({ code: 'not_cancellable' });
  });

  it('retry re-queues failed recipients under a new version', async () => {
    const { g } = await scheduledAndArmed();
    row().schedule_status = 'failed';
    for (const r of state.tables.broadcast_recipients) r.status = 'failed';

    const res = await retryScheduledBroadcast(db(), g.backend, {
      accountId: 'acct',
      broadcastId: BC,
      scope: 'all',
      now: AT,
    });
    expect(res.recipients).toBe(3);
    expect(row().schedule_status).toBe('queued');
    expect(row().schedule_version).toBe(2);
    expect(state.tables.broadcast_recipients.every((r) => r.status === 'pending')).toBe(true);

    const task = g.tasks.get(res.cloudTaskId)!;
    expect(task.payload).toMatchObject({ version: 2, trigger: 'retry' });
    // Retries are exempt from the lateness check.
    const out = await handleExecute(db(), g.backend, cfg, task.payload as ExecutePayload, {
      now: new Date(AT.getTime() + 24 * 3600_000),
    });
    expect(out).toMatchObject({ outcome: 'completed', sent: 3 });
  });
});

describe('reconcile', () => {
  it('arms a row whose Scheduler job never fired', async () => {
    const g = fakeBackend();
    await scheduleBroadcast(db(), g.backend, cfg, {
      accountId: 'acct',
      broadcastId: BC,
      scheduledAt: AT,
      timezone: 'Asia/Kolkata',
      now: NOW,
    });
    const report = await handleReconcile(db(), g.backend, cfg, new Date(AT.getTime() - 30_000));
    expect(report.armed).toEqual([BC]);
    expect(row().schedule_status).toBe('queued');
  });

  it('leaves healthy rows alone', async () => {
    const { g } = await scheduledAndArmed();
    const before = g.tasks.size;
    const report = await handleReconcile(db(), g.backend, cfg, new Date(AT.getTime() - 60_000));
    expect(report).toMatchObject({ armed: [], requeued: [], resumed: [] });
    expect(g.tasks.size).toBe(before);
  });
});
