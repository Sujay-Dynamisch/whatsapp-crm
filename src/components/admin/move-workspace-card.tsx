"use client";

// Super admin: move this user into another workspace with a role /
// custom role (e.g. someone who signed up into their own workspace
// instead of joining Swapnil's as a Caller). See migration 091.

import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { confirmDialog } from "@/components/ui/confirm-dialog";

interface Workspace {
  id: string;
  name: string;
  roles: { id: string; name: string; base_role: string }[];
}

const SELECT =
  "flex h-9 w-full rounded-md border border-border/70 bg-card px-3 py-1 text-sm shadow-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function MoveWorkspaceCard({
  userId,
  currentAccountId,
  onMoved,
}: {
  userId: string;
  currentAccountId: string | null;
  onMoved: () => void;
}) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [accountId, setAccountId] = useState("");
  const [roleKey, setRoleKey] = useState("agent"); // "agent" | "admin" | "viewer" | "custom:<id>"
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/users/${userId}/move`)
      .then((r) => r.json())
      .then((d: { accounts?: Workspace[] }) => alive && setWorkspaces(d.accounts ?? []))
      .catch(() => alive && setWorkspaces([]));
    return () => {
      alive = false;
    };
  }, [userId]);

  const target = useMemo(() => workspaces?.find((w) => w.id === accountId) ?? null, [workspaces, accountId]);

  const move = async () => {
    if (!target) return;
    const custom = roleKey.startsWith("custom:") ? target.roles.find((r) => `custom:${r.id}` === roleKey) : null;
    const role = custom ? custom.base_role : roleKey;
    const ok = await confirmDialog({
      title: `Move this user to “${target.name}”?`,
      description: `They join as ${custom ? custom.name : role}. If they own an empty workspace from sign-up, it is removed. A workspace with data or other members is never deleted — the move is refused instead.`,
      confirmLabel: "Move user",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: target.id, role, customRoleId: custom?.id ?? null }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not move the user");
      toast.success(`Moved to ${target.name}`);
      setAccountId("");
      onMoved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move the user");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card/50 p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ArrowRightLeft className="size-4 text-primary" />
        <h3 className="text-sm font-bold text-foreground">Move to another workspace</h3>
      </div>
      <p className="text-xs text-muted-foreground">
        For someone who signed up into their own workspace by mistake — put them into the right workspace with the right role.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Workspace</Label>
          <select
            className={SELECT}
            value={accountId}
            disabled={!workspaces || busy}
            onChange={(e) => {
              setAccountId(e.target.value);
              setRoleKey("agent");
            }}
          >
            <option value="">{workspaces ? "Choose a workspace…" : "Loading…"}</option>
            {(workspaces ?? [])
              .filter((w) => w.id !== currentAccountId)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-medium">Role in that workspace</Label>
          <select className={SELECT} value={roleKey} disabled={!target || busy} onChange={(e) => setRoleKey(e.target.value)}>
            {target?.roles.length ? (
              <optgroup label="Custom roles">
                {target.roles.map((r) => (
                  <option key={r.id} value={`custom:${r.id}`}>
                    {r.name} ({r.base_role})
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Built-in roles">
              <option value="admin">Administrator</option>
              <option value="agent">Agent</option>
              <option value="viewer">Viewer</option>
            </optgroup>
          </select>
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={!target || busy} onClick={() => void move()}>
          {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
          Move user
        </Button>
      </div>
    </div>
  );
}
