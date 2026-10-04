// ============================================================
// Cloud Scheduler + Cloud Tasks over their REST APIs.
//
// Exposed through the small {@link SchedulingBackend} interface so the
// orchestration logic can be unit-tested against a fake. All four
// operations are idempotent: create treats 409 ALREADY_EXISTS as
// success (names are deterministic, see ids.ts) and delete treats 404
// as success.
// ============================================================

import { getGcpAccessToken } from './gcp-auth';
import { SCHEDULER_SECRET_HEADER, type SchedulingConfig } from './config';

export interface CreateJobInput {
  jobId: string;
  cron: string;
  timeZone: string;
  description: string;
  payload: unknown;
}

export interface CreateTaskInput {
  taskId: string;
  scheduleTime: Date;
  payload: unknown;
}

export interface SchedulingBackend {
  /** Returns the full job resource name. */
  createSchedulerJob(input: CreateJobInput): Promise<string>;
  deleteSchedulerJob(jobName: string): Promise<void>;
  /** Returns the full task resource name. */
  createTask(input: CreateTaskInput): Promise<string>;
  deleteTask(taskName: string): Promise<void>;
}

export class GcpApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GcpApiError';
    this.status = status;
  }
}

const SCHEDULER_API = 'https://cloudscheduler.googleapis.com/v1';
const TASKS_API = 'https://cloudtasks.googleapis.com/v2';

async function call(
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await getGcpAccessToken();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function fail(op: string, status: number, json: Record<string, unknown>): never {
  const err = json.error as { message?: string } | undefined;
  throw new GcpApiError(status, `${op} failed (${status}): ${err?.message ?? 'unknown error'}`);
}

function encodeBody(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function createGcpBackend(cfg: SchedulingConfig): SchedulingBackend {
  const parent = `projects/${cfg.projectId}/locations/${cfg.location}`;
  const queue = `${parent}/queues/${cfg.queue}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.sharedSecret) headers[SCHEDULER_SECRET_HEADER] = cfg.sharedSecret;

  return {
    async createSchedulerJob(input) {
      const name = `${parent}/jobs/${input.jobId}`;
      const { status, json } = await call('POST', `${SCHEDULER_API}/${parent}/jobs`, {
        name,
        description: input.description,
        schedule: input.cron,
        timeZone: input.timeZone,
        attemptDeadline: '60s',
        retryConfig: {
          retryCount: 3,
          minBackoffDuration: '10s',
          maxBackoffDuration: '60s',
        },
        httpTarget: {
          uri: cfg.armUrl,
          httpMethod: 'POST',
          headers,
          body: encodeBody(input.payload),
          oidcToken: {
            serviceAccountEmail: cfg.invokerServiceAccount,
            audience: cfg.armUrl,
          },
        },
      });
      if (status === 409 || (status >= 200 && status < 300)) return name;
      fail('Cloud Scheduler createJob', status, json);
    },

    async deleteSchedulerJob(jobName) {
      const { status, json } = await call('DELETE', `${SCHEDULER_API}/${jobName}`);
      if (status === 404 || (status >= 200 && status < 300)) return;
      fail('Cloud Scheduler deleteJob', status, json);
    },

    async createTask(input) {
      const name = `${queue}/tasks/${input.taskId}`;
      const { status, json } = await call('POST', `${TASKS_API}/${queue}/tasks`, {
        task: {
          name,
          scheduleTime: input.scheduleTime.toISOString(),
          // Cloud Tasks' HTTP maximum. The execute function caps each
          // invocation at BROADCAST_PASS_SIZE recipients well inside it.
          dispatchDeadline: '1800s',
          httpRequest: {
            url: cfg.executeUrl,
            httpMethod: 'POST',
            headers,
            body: encodeBody(input.payload),
            oidcToken: {
              serviceAccountEmail: cfg.invokerServiceAccount,
              audience: cfg.executeUrl,
            },
          },
        },
      });
      if (status === 409 || (status >= 200 && status < 300)) return name;
      fail('Cloud Tasks createTask', status, json);
    },

    async deleteTask(taskName) {
      const { status, json } = await call('DELETE', `${TASKS_API}/${taskName}`);
      if (status === 404 || (status >= 200 && status < 300)) return;
      fail('Cloud Tasks deleteTask', status, json);
    },
  };
}

/** Full resource name for a job id under this config. */
export function schedulerJobName(cfg: SchedulingConfig, jobId: string): string {
  return `projects/${cfg.projectId}/locations/${cfg.location}/jobs/${jobId}`;
}
