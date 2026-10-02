"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Users, CheckCircle2, Building2, UserPlus } from "lucide-react";

interface AdminStats {
  totalUsers: number;
  confirmedUsers: number;
  totalAccounts: number;
  newThisWeek: number;
}

interface AdminStatsCardsProps {
  stats: AdminStats | null;
  loading: boolean;
}

export function AdminStatsCards({ stats, loading }: AdminStatsCardsProps) {
  const cards = [
    {
      title: "Total Registered Users",
      value: stats?.totalUsers ?? 0,
      description: "Across all customer accounts",
      icon: Users,
      gradient: "from-blue-500/20 to-indigo-500/5",
      iconColor: "text-blue-400",
      borderColor: "border-blue-500/20",
    },
    {
      title: "Active / Verified Accounts",
      value: stats?.confirmedUsers ?? 0,
      description: "Pre-verified & active sign-ins",
      icon: CheckCircle2,
      gradient: "from-emerald-500/20 to-teal-500/5",
      iconColor: "text-emerald-400",
      borderColor: "border-emerald-500/20",
    },
    {
      title: "Customer Workspaces",
      value: stats?.totalAccounts ?? 0,
      description: "Provisioned organizations",
      icon: Building2,
      gradient: "from-purple-500/20 to-pink-500/5",
      iconColor: "text-purple-400",
      borderColor: "border-purple-500/20",
    },
    {
      title: "New This Week",
      value: stats?.newThisWeek ?? 0,
      description: "Recently onboarded users",
      icon: UserPlus,
      gradient: "from-amber-500/20 to-orange-500/5",
      iconColor: "text-amber-400",
      borderColor: "border-amber-500/20",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card, idx) => {
        const Icon = card.icon;
        return (
          <Card
            key={idx}
            className={`relative overflow-hidden border ${card.borderColor} bg-card/60 backdrop-blur-md transition-all hover:bg-card/80`}
          >
            <div
              className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${card.gradient}`}
            />
            <CardContent className="relative p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {card.title}
                </span>
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-xl bg-background/50 border border-white/5 ${card.iconColor}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-3">
                {loading ? (
                  <div className="h-8 w-16 animate-pulse rounded bg-muted" />
                ) : (
                  <div className="text-2xl font-bold tracking-tight text-foreground">
                    {card.value}
                  </div>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  {card.description}
                </p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
