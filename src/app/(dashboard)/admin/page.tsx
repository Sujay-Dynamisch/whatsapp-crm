"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { isSystemAdmin } from "@/lib/auth/admin";
import { AdminStatsCards } from "@/components/admin/admin-stats-cards";
import {
  AdminUsersTable,
  type AdminUserRecord,
} from "@/components/admin/admin-users-table";
import { OnboardCustomerDialog } from "@/components/admin/onboard-customer-dialog";
import { ShieldCheck, Sparkles, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function AdminPortalPage() {
  const { user, profile, loading: authLoading } = useAuth();
  const router = useRouter();

  const [users, setUsers] = useState<AdminUserRecord[]>([]);
  const [stats, setStats] = useState<{
    totalUsers: number;
    confirmedUsers: number;
    totalAccounts: number;
    newThisWeek: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/users");
      if (res.status === 403 || res.status === 401) {
        setUnauthorized(true);
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to fetch users");
      }

      setUsers(data.users || []);
      setStats(data.stats || null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error loading users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading) {
      if (!user || !isSystemAdmin(user.email, profile?.role)) {
        setUnauthorized(true);
      } else {
        fetchUsers();
      }
    }
  }, [user, profile, authLoading, fetchUsers]);

  if (authLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Verifying administrator access...</p>
        </div>
      </div>
    );
  }

  if (unauthorized) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center p-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 border border-red-500/20 text-red-400 mb-4">
          <AlertCircle className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-bold text-foreground">Access Restricted</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">
          You must be logged in as the system administrator (admin@gmail.com) to access the platform management portal.
        </p>
        <button
          onClick={() => router.push("/dashboard")}
          className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Return to Dashboard
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header Banner */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between rounded-2xl border border-primary/20 bg-gradient-to-r from-card via-card to-primary/5 p-6 shadow-sm">
        <div>
          <div className="flex items-center gap-2 text-emerald-400 mb-1">
            <ShieldCheck className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-wider">
              System Admin Portal
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            Platform Management & Onboarding
          </h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            View all registered customers, provision new tenant workspaces with zero email verification, and manage platform credentials.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <OnboardCustomerDialog onCustomerCreated={fetchUsers} />
        </div>
      </div>

      {/* Stats Cards */}
      <AdminStatsCards stats={stats} loading={loading} />

      {/* All Users Directory Table */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-foreground">
              Customer & User Directory
            </h2>
            <p className="text-xs text-muted-foreground">
              Real-time directory of all platform accounts and members
            </p>
          </div>
        </div>

        <AdminUsersTable
          users={users}
          loading={loading}
          onRefresh={fetchUsers}
        />
      </div>
    </div>
  );
}
