"use client";

// Owners / admins with the 'failed_messages' feature (migration 060):
// a red strip when the scheduler has stopped or the website lead feed is
// failing (a stopped scheduler can't send its own alarm), and a top-right
// popup for each new health alert. Renders nothing otherwise.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";

interface Health {
  scheduler: { last_at: string | null; ok: boolean | null };
  lead_feed: { state: "ok" | "failing" | "off"; error: string | null };
}

const POLL_MS = 2 * 60_000;

export function HealthBanner() {
  const t = useTranslations("FailedMessages");
  const { hasFeature, canManageMembers } = useAuth();
  const enabled = hasFeature("failed_messages") && canManageMembers;
  const [health, setHealth] = useState<Health | null>(null);
  const router = useRouter();
  const tRef = useRef(t);
  const routerRef = useRef(router);
  useEffect(() => {
    tRef.current = t;
    routerRef.current = router;
  }, [t, router]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      const res = await fetch("/api/health").catch(() => null);
      if (!cancelled && res?.ok) setHealth(await res.json());
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);

    const supabase = createClient();
    const channel = supabase
      .channel("health-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const n = payload.new as { type?: string; title?: string; body?: string | null };
        if (n.type !== "health_alert") return;
        toast.warning(n.title ?? "", {
          description: n.body ?? undefined,
          duration: 30_000,
          action: { label: tRef.current("banner.open"), onClick: () => routerRef.current.push("/failed-messages") },
        });
        void poll();
      })
      .subscribe();
    return () => {
      cancelled = true;
      clearInterval(id);
      supabase.removeChannel(channel);
    };
  }, [enabled]);

  if (!enabled || !health) return null;
  const down = health.scheduler.ok === false && health.scheduler.last_at;
  const feed = health.lead_feed.state === "failing";
  if (!down && !feed) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-700 dark:text-rose-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1 space-y-0.5">
        {down && <p>{t("banner.schedulerDown", { when: formatDistanceToNow(new Date(health.scheduler.last_at!), { addSuffix: true }) })}</p>}
        {feed && <p>{t("banner.feedFailing")}</p>}
      </div>
      <Link href="/failed-messages" className="shrink-0 font-medium underline underline-offset-2">
        {t("banner.open")}
      </Link>
    </div>
  );
}
