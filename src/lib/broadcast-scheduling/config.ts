// ============================================================
// Scheduling-layer configuration, read from the environment.
//
// The same variables are set on the Next.js deployment (which creates
// jobs/tasks when a user schedules) and on the Cloud Functions (which
// create the per-broadcast task and continuation tasks). Google
// credentials are NOT here — see gcp-auth.ts.
// ============================================================

export interface SchedulingConfig {
  projectId: string;
  /** Region for Cloud Scheduler, Cloud Tasks and the functions. */
  location: string;
  queue: string;
  /** HTTPS URL of the armBroadcast function (Scheduler target). */
  armUrl: string;
  /** HTTPS URL of the executeBroadcast function (Cloud Tasks target). */
  executeUrl: string;
  /** Service account whose OIDC token Scheduler/Tasks present. */
  invokerServiceAccount: string;
  /** Optional shared secret sent as a header — defence in depth on top of IAM. */
  sharedSecret: string | null;
  /** How long before scheduled_at the Scheduler job fires. */
  leadMs: number;
  /** A trigger arriving later than this after scheduled_at fails instead of sending. */
  maxLatenessMs: number;
  /** Recipients delivered per execute invocation before handing off to a continuation task. */
  passSize: number;
  /** Must match the queue's --max-attempts; the last attempt marks the broadcast failed. */
  taskMaxAttempts: number;
}

export class SchedulingNotConfiguredError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Scheduled broadcasts are not configured. Missing env: ${missing.join(', ')}`
    );
    this.name = 'SchedulingNotConfiguredError';
    this.missing = missing;
  }
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function readSchedulingConfig(env: Env = process.env): SchedulingConfig {
  const required = {
    projectId: 'GCP_PROJECT_ID',
    armUrl: 'BROADCAST_ARM_FUNCTION_URL',
    executeUrl: 'BROADCAST_EXECUTE_FUNCTION_URL',
    invokerServiceAccount: 'BROADCAST_INVOKER_SERVICE_ACCOUNT',
  } as const;

  const missing = Object.values(required).filter((k) => !env[k]?.trim());
  if (missing.length > 0) throw new SchedulingNotConfiguredError(missing);

  return {
    projectId: env.GCP_PROJECT_ID!.trim(),
    location: env.GCP_LOCATION?.trim() || 'asia-south1',
    queue: env.GCP_TASKS_QUEUE?.trim() || 'broadcast-dispatch',
    armUrl: env.BROADCAST_ARM_FUNCTION_URL!.trim(),
    executeUrl: env.BROADCAST_EXECUTE_FUNCTION_URL!.trim(),
    invokerServiceAccount: env.BROADCAST_INVOKER_SERVICE_ACCOUNT!.trim(),
    sharedSecret: env.BROADCAST_SCHEDULER_SECRET?.trim() || null,
    leadMs: int(env, 'BROADCAST_SCHEDULE_LEAD_SECONDS', 120, 30) * 1000,
    maxLatenessMs: int(env, 'BROADCAST_MAX_LATENESS_MINUTES', 360, 1) * 60_000,
    passSize: int(env, 'BROADCAST_PASS_SIZE', 500, 1),
    taskMaxAttempts: int(env, 'BROADCAST_TASK_MAX_ATTEMPTS', 5, 1),
  };
}

/** Header carrying {@link SchedulingConfig.sharedSecret}. */
export const SCHEDULER_SECRET_HEADER = 'x-broadcast-scheduler-secret';
