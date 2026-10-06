#!/usr/bin/env bash
# ============================================================
# One-shot, re-runnable setup + deploy for scheduled broadcasts.
#
#   GCP_PROJECT_ID=my-proj \
#   SUPABASE_URL=https://xyz.supabase.co \
#   SUPABASE_SERVICE_ROLE_KEY=... \
#   ENCRYPTION_KEY=... \
#   ./deploy.sh
#
# Secrets are written to Secret Manager on first run only (a new
# version is added if you pass a value and the secret already exists
# with a different one — rotate deliberately). Everything else is
# create-if-missing, so re-running after a code change just redeploys.
# See docs/scheduled-broadcasts.md for what each step is for.
# ============================================================
set -euo pipefail

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
: "${SUPABASE_URL:?set SUPABASE_URL}"
REGION="${GCP_LOCATION:-asia-south1}"
QUEUE="${GCP_TASKS_QUEUE:-broadcast-dispatch}"
MAX_ATTEMPTS="${BROADCAST_TASK_MAX_ATTEMPTS:-5}"

RUNTIME_SA="broadcast-fn@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
INVOKER_SA="broadcast-invoker@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
APP_SA="broadcast-app@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

gc() { gcloud --project "$GCP_PROJECT_ID" "$@"; }
here="$(cd "$(dirname "$0")" && pwd)"

echo "==> Enabling APIs"
gc services enable \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com \
  cloudtasks.googleapis.com secretmanager.googleapis.com iam.googleapis.com \
  logging.googleapis.com

echo "==> Service accounts"
for sa in broadcast-fn broadcast-invoker broadcast-app; do
  gc iam service-accounts describe "${sa}@${GCP_PROJECT_ID}.iam.gserviceaccount.com" >/dev/null 2>&1 \
    || gc iam service-accounts create "$sa" --display-name "WACRM scheduled broadcasts ($sa)"
done

echo "==> Secrets"
put_secret() { # name value
  local name="$1" value="$2"
  if ! gc secrets describe "$name" >/dev/null 2>&1; then
    printf '%s' "$value" | gc secrets create "$name" --replication-policy=automatic --data-file=-
  elif [ -n "$value" ]; then
    current="$(gc secrets versions access latest --secret "$name" 2>/dev/null || true)"
    [ "$current" = "$value" ] || printf '%s' "$value" | gc secrets versions add "$name" --data-file=-
  fi
}
put_secret wacrm-supabase-service-role-key "${SUPABASE_SERVICE_ROLE_KEY:-}"
put_secret wacrm-encryption-key "${ENCRYPTION_KEY:-}"
if ! gc secrets describe wacrm-broadcast-scheduler-secret >/dev/null 2>&1; then
  put_secret wacrm-broadcast-scheduler-secret "${BROADCAST_SCHEDULER_SECRET:-$(openssl rand -hex 32)}"
fi
for s in wacrm-supabase-service-role-key wacrm-encryption-key wacrm-broadcast-scheduler-secret; do
  gc secrets add-iam-policy-binding "$s" --member "serviceAccount:${RUNTIME_SA}" \
    --role roles/secretmanager.secretAccessor >/dev/null
done

echo "==> IAM"
# Functions (runtime SA) and the Next.js app (app SA) both create/delete
# Scheduler jobs and Cloud Tasks, and must be able to mint OIDC tokens
# as the invoker SA when doing so (iam.serviceAccountUser = actAs).
for member in "serviceAccount:${RUNTIME_SA}" "serviceAccount:${APP_SA}"; do
  for role in roles/cloudtasks.enqueuer roles/cloudtasks.taskDeleter roles/cloudscheduler.admin; do
    gc projects add-iam-policy-binding "$GCP_PROJECT_ID" --member "$member" --role "$role" \
      --condition=None >/dev/null
  done
  gc iam service-accounts add-iam-policy-binding "$INVOKER_SA" --member "$member" \
    --role roles/iam.serviceAccountUser >/dev/null
done

echo "==> Cloud Tasks queue ${QUEUE}"
QUEUE_FLAGS=(--location "$REGION" --max-attempts "$MAX_ATTEMPTS" --min-backoff 10s
  --max-backoff 300s --max-doublings 4 --max-dispatches-per-second 5 --max-concurrent-dispatches 20)
if gc tasks queues describe "$QUEUE" --location "$REGION" >/dev/null 2>&1; then
  gc tasks queues update "$QUEUE" "${QUEUE_FLAGS[@]}"
else
  gc tasks queues create "$QUEUE" "${QUEUE_FLAGS[@]}"
fi

echo "==> Bundling"
( cd "$here" && npm install --no-audit --no-fund && npm run bundle )

url_of() { gc functions describe "$1" --region "$REGION" --format 'value(serviceConfig.uri)' 2>/dev/null || true; }
ARM_URL="$(url_of armBroadcast)"
EXEC_URL="$(url_of executeBroadcast)"

ENV_VARS="SUPABASE_URL=${SUPABASE_URL},GCP_PROJECT_ID=${GCP_PROJECT_ID},GCP_LOCATION=${REGION},GCP_TASKS_QUEUE=${QUEUE}"
ENV_VARS+=",BROADCAST_INVOKER_SERVICE_ACCOUNT=${INVOKER_SA},BROADCAST_TASK_MAX_ATTEMPTS=${MAX_ATTEMPTS}"
ENV_VARS+=",BROADCAST_ARM_FUNCTION_URL=${ARM_URL:-pending},BROADCAST_EXECUTE_FUNCTION_URL=${EXEC_URL:-pending}"
for opt in BROADCAST_SCHEDULE_LEAD_SECONDS BROADCAST_MAX_LATENESS_MINUTES BROADCAST_PASS_SIZE; do
  if [ -n "${!opt:-}" ]; then ENV_VARS+=",${opt}=${!opt}"; fi
done
SECRETS="SUPABASE_SERVICE_ROLE_KEY=wacrm-supabase-service-role-key:latest,ENCRYPTION_KEY=wacrm-encryption-key:latest,BROADCAST_SCHEDULER_SECRET=wacrm-broadcast-scheduler-secret:latest"

deploy() { # name timeout memory
  gc functions deploy "$1" --gen2 --region "$REGION" --runtime nodejs22 \
    --source "$here" --entry-point "$1" --trigger-http --no-allow-unauthenticated \
    --service-account "$RUNTIME_SA" --timeout "$2" --memory "$3" \
    --max-instances 20 --set-env-vars "$ENV_VARS" --set-secrets "$SECRETS"
}

echo "==> Deploying functions"
deploy armBroadcast 60s 256Mi
deploy executeBroadcast 1800s 512Mi
deploy reconcileBroadcasts 300s 256Mi
deploy windowKeepalive 300s 256Mi

ARM_URL="$(url_of armBroadcast)"
EXEC_URL="$(url_of executeBroadcast)"
RECONCILE_URL="$(url_of reconcileBroadcasts)"
KEEPALIVE_URL="$(url_of windowKeepalive)"

# First deploy didn't know its own URLs yet — patch them in.
for fn in armBroadcast executeBroadcast reconcileBroadcasts windowKeepalive; do
  svc="$(gc functions describe "$fn" --region "$REGION" --format 'value(serviceConfig.service)' | sed 's#.*/##')"
  gc run services update "$svc" --region "$REGION" --quiet \
    --update-env-vars "BROADCAST_ARM_FUNCTION_URL=${ARM_URL},BROADCAST_EXECUTE_FUNCTION_URL=${EXEC_URL}" >/dev/null
  # Only the invoker SA may call the functions.
  gc functions add-invoker-policy-binding "$fn" --region "$REGION" \
    --member "serviceAccount:${INVOKER_SA}" >/dev/null
done

SECRET_VALUE="$(gc secrets versions access latest --secret wacrm-broadcast-scheduler-secret)"
every5min() { # job-name target-url
  local flags=(--location "$REGION" --schedule "*/5 * * * *" --time-zone "Etc/UTC"
    --uri "$2" --http-method POST --message-body '{}'
    --oidc-service-account-email "$INVOKER_SA" --oidc-token-audience "$2"
    --attempt-deadline 300s)
  if gc scheduler jobs describe "$1" --location "$REGION" >/dev/null 2>&1; then
    gc scheduler jobs update http "$1" "${flags[@]}" \
      --update-headers "Content-Type=application/json,x-broadcast-scheduler-secret=${SECRET_VALUE}"
  else
    gc scheduler jobs create http "$1" "${flags[@]}" \
      --headers "Content-Type=application/json,x-broadcast-scheduler-secret=${SECRET_VALUE}"
  fi
}

echo "==> Reconciler schedule (every 5 minutes)"
every5min broadcast-reconcile "$RECONCILE_URL"

echo "==> 24h-window keep-alive schedule (every 5 minutes)"
every5min conversation-window-keepalive "$KEEPALIVE_URL"

cat <<EOF

==> Done. Set these on the Next.js deployment (server-side env only):

  NEXT_PUBLIC_BROADCAST_SCHEDULING_ENABLED=true
  GCP_PROJECT_ID=${GCP_PROJECT_ID}
  GCP_LOCATION=${REGION}
  GCP_TASKS_QUEUE=${QUEUE}
  BROADCAST_ARM_FUNCTION_URL=${ARM_URL}
  BROADCAST_EXECUTE_FUNCTION_URL=${EXEC_URL}
  BROADCAST_INVOKER_SERVICE_ACCOUNT=${INVOKER_SA}
  BROADCAST_SCHEDULER_SECRET=<value of secret wacrm-broadcast-scheduler-secret>
  GCP_SERVICE_ACCOUNT_KEY=<base64 key for ${APP_SA}; omit when the app runs on Google Cloud as that SA>

To mint the app key (only if the app is hosted outside Google Cloud):
  gcloud iam service-accounts keys create app-key.json --iam-account ${APP_SA}
  base64 -w0 app-key.json   # paste as GCP_SERVICE_ACCOUNT_KEY, then delete app-key.json
EOF
