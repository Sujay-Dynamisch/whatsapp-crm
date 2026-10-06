# Scheduled broadcasts

Schedule a WhatsApp broadcast for a future time and have it delivered server-side. Nothing has to stay open while you wait: no browser tab, VPS, or always-on server. Supabase stays the source of truth. Google Cloud supplies the timing, and two Cloud Functions do the work.

```
 Wizard / API ──► Supabase row  schedule_status = scheduled
                     │
                     │  Next.js creates a Cloud Scheduler job for T-2 min
                     ▼
            Cloud Scheduler (T-2 min) ──OIDC──► armBroadcast
                                                  │ creates Cloud Task for exactly T
                                                  │ row → queued, deletes its own job
                                                  ▼
                               Cloud Tasks (T) ──OIDC──► executeBroadcast
                                                           │ atomic claim → processing
                                                           │ existing deliverBroadcast()
                                                           ▼
                                                     WhatsApp Cloud API
                                                           │
                                     row → completed | failed (+ execution_result)
                                     (or a continuation task for the next pass)

 Cloud Scheduler (*/5 min) ──OIDC──► reconcileBroadcasts   (safety net)
```

If you schedule a send less than ~3 minutes out, it skips Cloud Scheduler and goes straight to a Cloud Task with the exact time.

## How it works

### State

`broadcasts.status` keeps its existing meaning in the UI (`scheduled → sending → sent | failed`) and gains `cancelled`. The new `broadcasts.schedule_status` column tracks the scheduling pipeline. It is `NULL` for immediate sends.

| schedule_status | Meaning | Who sets it |
|---|---|---|
| `scheduled` | Scheduler job armed for T-2 min | Next.js (schedule / reschedule) |
| `queued` | Cloud Task created for exactly T | `armBroadcast`, or Next.js for near-term sends and retries |
| `processing` | A delivery pass holds the lock | `executeBroadcast` |
| `completed` | No pending recipients left, and at least one send reached Meta | `executeBroadcast` |
| `failed` | Every recipient failed, a config/template error, a missed schedule, or retries ran out | `executeBroadcast` / trigger creation |
| `cancelled` | Cancelled by the user | Next.js |

Execution metadata lives on the same row: `scheduled_at`, `timezone`, `scheduler_job_id`, `cloud_task_id`, `queued_at`, `execution_started_at`, `completed_at`, `failed_at`, `cancelled_at`, `execution_attempts`, `last_error`, `last_error_at`, and `execution_result` (`{ total, sent, failed, pending, passes }`). Per-message results stay where they always were, in `broadcast_recipients` (`status`, `whatsapp_message_id`, `error_message`, and delivered/read via the webhook).

### Safety properties

- **No duplicate triggers.** Job and task names are deterministic: `bc-<broadcastId>-v<version>` and `<hash>-bc-<broadcastId>-v<version>-p<pass>`. A repeated create gets `ALREADY_EXISTS`, which the code treats as success.
- **Reschedule and cancel are race-free.** Every schedule, reschedule, cancel, or retry bumps `schedule_version` in one conditional UPDATE. Each trigger carries the version it was created for, and a trigger with a stale version does nothing. Deleting the old job or task is only cleanup; correctness doesn't depend on it.
- **One execution at a time.** `executeBroadcast` claims the row with a single conditional UPDATE. The UPDATE checks the version, requires `schedule_status IN (scheduled, queued, processing)`, and requires `delivery_locked_at` to be free or stale. This is the same lock the dashboard's Resume button uses, so a manual resume and a scheduled pass can't overlap. If a duplicate task arrives while the lock is held, it gets a 503 and Cloud Tasks retries it later. If it arrives after completion, it gets a 200 no-op.
- **Each recipient is sent at most once per pass.** Only `pending` recipient rows are planned, and each row is stamped `sent` or `failed` right after its Meta call. One edge case remains: if the process crashes after Meta accepts a message but before the row is stamped, that one message is re-sent when delivery resumes. The window is a single recipient.
- **No waiting inside a function.** Scheduler and Tasks hold the time. The functions run only when called and return as soon as their work is done.
- **Large broadcasts are split.** Each invocation sends at most `BROADCAST_PASS_SIZE` recipients (default 500). If any remain, it enqueues a continuation task (`…-p<n+1>`) and returns.
- **Late sends fail instead of going out.** If a scheduled trigger arrives more than `BROADCAST_MAX_LATENESS_MINUTES` (default 360) after `scheduled_at`, for example after an outage, the broadcast is marked `failed` with `missed_schedule` rather than sent hours late. You can still retry it deliberately.
- **Unsubscribes are honoured at send time.** Contacts tagged `unsubscribe` after scheduling are stamped `failed` instead of being messaged.
- **Reconciler.** Every 5 minutes, `reconcileBroadcasts` re-arms rows still `scheduled` within a minute of T, re-queues rows `queued` more than 10 minutes past T, and resumes `processing` rows whose lock went stale. All of these are idempotent.

### Reuse of the existing broadcast code

The scheduling layer doesn't contain a send loop of its own. Planning uses `planBroadcastResume`, which reads frozen per-recipient params and validates phones and templates. Sending uses `deliverBroadcast`, which handles phone-variant retry, per-recipient stamping, and trigger-owned counts. The Cloud Function bundle is built from the app's own `src/`, so a fix to delivery applies to both paths.

When planning a broadcast, the wizard now also freezes each recipient's structured send params (header media URL, carousel and button values) into `broadcast_recipients.message_params`. This lets a server-side send match what the browser would have sent. It also makes the existing Resume more faithful.

## API

All routes need the `agent` role and use the caller's RLS-scoped Supabase session. No service-role key is involved.

| Method & path | Body | Effect |
|---|---|---|
| `POST /api/whatsapp/broadcast/:id/schedule` | `{ "local_datetime": "2026-10-05T09:30", "timezone": "Asia/Kolkata" }` or `{ "scheduled_at": "2026-10-05T09:30:00+05:30" }` | Create or reschedule. `timezone` defaults to `Asia/Kolkata`. `scheduled_at` must include an offset. |
| `DELETE /api/whatsapp/broadcast/:id/schedule` | — | Cancel. Allowed while `scheduled`, `queued`, or `failed`. |
| `POST /api/whatsapp/broadcast/:id/schedule/retry` | `{ "scope": "all" \| "failed" \| "pending" }` | Re-run a `failed` or `completed` broadcast now through Cloud Tasks. `failed` and `all` first return failed recipients to `pending`. |

Validation rules:

- A time more than 60 seconds in the past is rejected with `schedule_in_past`.
- A time more than 364 days ahead is rejected. A cron expression has no year field, so it can only identify a unique minute within the next 12 months.
- A broadcast must have pending recipients to be scheduled.
- A broadcast can't be rescheduled once it is `processing` or `completed`.

The broadcast row and its `pending` recipients must already exist. The wizard creates them exactly as it does for an immediate send, but with `status = 'scheduled'`, and then calls the schedule route.

## Google Cloud setup

### APIs

`cloudfunctions`, `run`, `cloudbuild`, `artifactregistry`, `cloudscheduler`, `cloudtasks`, `secretmanager`, `iam`, `logging` (all `*.googleapis.com`).

### Service accounts and IAM

| Service account | Used by | Roles |
|---|---|---|
| `broadcast-invoker@` | The identity Scheduler and Tasks present (OIDC) when calling the functions | `roles/run.invoker` on each of the three functions, and nothing else |
| `broadcast-fn@` | Runtime identity of the three functions | `roles/cloudtasks.enqueuer`, `roles/cloudtasks.taskDeleter`, `roles/cloudscheduler.admin` (deletes its one-shot jobs), `roles/iam.serviceAccountUser` on `broadcast-invoker@` (to attach its OIDC identity to tasks), `roles/secretmanager.secretAccessor` on the three secrets |
| `broadcast-app@` | The Next.js app, which creates and deletes jobs and tasks when users schedule | `roles/cloudtasks.enqueuer`, `roles/cloudtasks.taskDeleter`, `roles/cloudscheduler.admin`, `roles/iam.serviceAccountUser` on `broadcast-invoker@` |

All three functions are deployed with `--no-allow-unauthenticated`, so Cloud Run rejects any request without a valid Google-signed token for `broadcast-invoker@`. The `x-broadcast-scheduler-secret` header is an extra check on top of IAM.

### Secrets (Secret Manager)

| Secret | Env var in the functions |
|---|---|
| `wacrm-supabase-service-role-key` | `SUPABASE_SERVICE_ROLE_KEY` |
| `wacrm-encryption-key` | `ENCRYPTION_KEY` (the same value as the app's, so the functions can decrypt the stored WhatsApp token) |
| `wacrm-broadcast-scheduler-secret` | `BROADCAST_SCHEDULER_SECRET` |

### Cloud Tasks queue

The queue is `broadcast-dispatch`, configured with `--max-attempts 5 --min-backoff 10s --max-backoff 300s --max-dispatches-per-second 5 --max-concurrent-dispatches 20`. Keep `BROADCAST_TASK_MAX_ATTEMPTS` equal to `--max-attempts`: on the last attempt, the function marks the broadcast `failed` instead of throwing.

## Deploy

1. **Apply the migration.** Run `supabase/migrations/043_scheduled_broadcasts.sql` (or `supabase db push`). It is idempotent.

2. **Deploy the functions.** You need `gcloud` authenticated as a project owner or equivalent. The script runs in bash (Cloud Shell, Linux, macOS, or WSL):

   ```bash
   cd cloud-functions/broadcast-scheduler
   GCP_PROJECT_ID=my-gcp-project \
   GCP_LOCATION=asia-south1 \
   SUPABASE_URL=https://xyz.supabase.co \
   SUPABASE_SERVICE_ROLE_KEY=... \
   ENCRYPTION_KEY=... \
   ./deploy.sh
   ```

   The script enables the APIs, creates the service accounts, secrets, IAM bindings and queue, bundles the code, and deploys the three functions (Gen 2, Node.js 22). It then wires the function URLs into the functions' env, grants invoker access, and creates the 5-minute `broadcast-reconcile` Scheduler job. It is safe to re-run after a code change, which simply redeploys.

   <details><summary>Core commands, if you'd rather run them yourself</summary>

   ```bash
   gcloud tasks queues create broadcast-dispatch --location asia-south1 --max-attempts 5 \
     --min-backoff 10s --max-backoff 300s --max-dispatches-per-second 5 --max-concurrent-dispatches 20

   npm install && npm run bundle          # → dist/index.js

   gcloud functions deploy executeBroadcast --gen2 --region asia-south1 --runtime nodejs22 \
     --source . --entry-point executeBroadcast --trigger-http --no-allow-unauthenticated \
     --service-account broadcast-fn@PROJECT.iam.gserviceaccount.com --timeout 1800s --memory 512Mi \
     --set-env-vars SUPABASE_URL=...,GCP_PROJECT_ID=...,GCP_LOCATION=asia-south1,GCP_TASKS_QUEUE=broadcast-dispatch,BROADCAST_INVOKER_SERVICE_ACCOUNT=broadcast-invoker@PROJECT.iam.gserviceaccount.com,BROADCAST_ARM_FUNCTION_URL=...,BROADCAST_EXECUTE_FUNCTION_URL=... \
     --set-secrets SUPABASE_SERVICE_ROLE_KEY=wacrm-supabase-service-role-key:latest,ENCRYPTION_KEY=wacrm-encryption-key:latest,BROADCAST_SCHEDULER_SECRET=wacrm-broadcast-scheduler-secret:latest
   # likewise armBroadcast (--timeout 60s) and reconcileBroadcasts (--timeout 300s)

   gcloud functions add-invoker-policy-binding executeBroadcast --region asia-south1 \
     --member serviceAccount:broadcast-invoker@PROJECT.iam.gserviceaccount.com

   gcloud scheduler jobs create http broadcast-reconcile --location asia-south1 \
     --schedule "*/5 * * * *" --uri RECONCILE_URL --http-method POST --message-body '{}' \
     --oidc-service-account-email broadcast-invoker@PROJECT.iam.gserviceaccount.com \
     --oidc-token-audience RECONCILE_URL \
     --headers Content-Type=application/json,x-broadcast-scheduler-secret=SECRET
   ```
   </details>

3. **Configure the Next.js app.** `deploy.sh` prints these values at the end. All are server-side except the `NEXT_PUBLIC_` flag:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_BROADCAST_SCHEDULING_ENABLED` | `true` (shows "Schedule for later" in the wizard; rebuild after changing it) |
   | `GCP_PROJECT_ID`, `GCP_LOCATION`, `GCP_TASKS_QUEUE` | as deployed |
   | `BROADCAST_ARM_FUNCTION_URL`, `BROADCAST_EXECUTE_FUNCTION_URL` | function URLs |
   | `BROADCAST_INVOKER_SERVICE_ACCOUNT` | `broadcast-invoker@PROJECT.iam.gserviceaccount.com` |
   | `BROADCAST_SCHEDULER_SECRET` | the value of secret `wacrm-broadcast-scheduler-secret` |
   | `GCP_SERVICE_ACCOUNT_KEY` | base64 key for `broadcast-app@`. Leave it unset when the app runs on Google Cloud as that service account, because the metadata server is used instead. |

   Optional tuning variables, which apply to both the app and the functions: `BROADCAST_SCHEDULE_LEAD_SECONDS` (default 120), `BROADCAST_MAX_LATENESS_MINUTES` (default 360), `BROADCAST_PASS_SIZE` (default 500), and `BROADCAST_TASK_MAX_ATTEMPTS` (default 5).

## Operations

- **Logs.** Each function writes one JSON line per invocation (`fn`, `broadcastId`, `version`, `pass`, `outcome`, …). To read them: `gcloud functions logs read executeBroadcast --region asia-south1`.
- **What is pending.** `gcloud scheduler jobs list --location asia-south1` and `gcloud tasks list --queue broadcast-dispatch --location asia-south1`.
- **A broadcast shows `failed`.** Its `last_error` gives the reason. `whatsapp_not_configured` and `template_malformed` need fixing in Settings before you retry. `missed_schedule` means the trigger was late. "Gave up after N attempts" means a transient error persisted. Use **Retry now** on the broadcast page, or the retry API.
- **Pausing everything.** `gcloud tasks queues pause broadcast-dispatch --location asia-south1`. Sends due during the pause fail as `missed_schedule` if the queue is resumed more than the lateness limit later.

## Limits

- Cloud Tasks accepts a schedule time at most 30 days ahead. This is why sends further out go through Cloud Scheduler first.
- Cloud Scheduler has minute resolution. That's fine here, because the job fires early and the Cloud Task carries the exact second.
- Cloud Tasks allows an HTTP dispatch deadline of at most 30 minutes. One pass of 500 recipients finishes well within it.
- Each pending scheduled broadcast holds one Cloud Scheduler job until it is armed. Check your project's Cloud Scheduler job quota if you expect thousands of future-dated broadcasts at once.

## 24-hour window keep-alive

WhatsApp accepts normal (non-template) messages only within 24 hours of the customer's last message. The `windowKeepalive` function, run by the `conversation-window-keepalive` Scheduler job every 5 minutes, sends one check-in shortly before that window closes. If the customer replies, the window re-opens for another 24 hours.

- **Settings:** Agents → Setup → *24-hour window keep-alive* (admins). There you set an on/off switch, the message text, how many minutes before the window closes to send (default 60, i.e. at hour 23), and a quiet period (default 30 minutes; the check-in is skipped if anyone messaged the customer that recently).
- **Once per window:** at most one check-in per customer message, so it can't loop. It is never sent to closed conversations or contacts tagged `unsubscribe`, and never with less than 5 minutes of window left.
- **How it works:** migration `044_window_keepalive.sql` adds `conversations.last_customer_message_at`, maintained by a trigger on `messages`, plus `claim_window_keepalives()`, which selects due conversations and marks them in one statement so overlapping runs can't double-send. A failed send releases its claim and is retried on the next run while the window is still open.
