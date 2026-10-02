"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  UsersRound,
  ShieldCheck,
  Loader2,
} from "lucide-react";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const t = useTranslations("LoginPage");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const supabase = createClient();

  const isAdmin = email.trim().toLowerCase() === "admin@gmail.com";

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    const destination = inviteToken
      ? `/join/${encodeURIComponent(inviteToken)}`
      : isAdmin
      ? "/admin"
      : "/dashboard";
    window.location.href = destination;
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12 selection:bg-primary/20 selection:text-primary">
      {/* Ambient background glowing orbs */}
      <div className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-500/15 blur-[128px]" />
      <div className="pointer-events-none absolute -bottom-40 right-1/4 -z-10 h-96 w-96 rounded-full bg-primary/15 blur-[140px]" />
      <div className="pointer-events-none absolute top-1/3 left-1/4 -z-10 h-72 w-72 rounded-full bg-teal-500/10 blur-[110px]" />

      {/* Subtle modern background grid */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(#ffffff0a_1px,transparent_1px)] [background-size:24px_24px] opacity-70" />

      {/* Outer Card with Glassmorphism & Subtle Glow */}
      <Card className="relative w-full max-w-[420px] rounded-3xl border border-white/10 bg-card/75 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-2">
        {/* Subtle top radiant edge highlight */}
        <div className="pointer-events-none absolute -top-px left-1/2 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-emerald-400/50 to-transparent" />

        <CardHeader className="items-center pb-6 text-center">
          {/* Logo Badge Container */}
          <div className="relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-500/30 bg-gradient-to-b from-emerald-500/20 to-emerald-500/5 shadow-[0_0_25px_rgba(37,211,102,0.2)] transition-transform hover:scale-105">
            {inviteToken ? (
              <UsersRound className="h-7 w-7 text-primary" />
            ) : (
              <Image
                src="/logo.png"
                alt="WACRM"
                width={56}
                height={56}
                className="h-9 w-9 object-contain drop-shadow"
                priority
              />
            )}
            <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[9px] font-bold text-black ring-2 ring-background">
              ✓
            </span>
          </div>

          <CardTitle className="text-2xl font-bold tracking-tight text-foreground sm:text-[26px]">
            {inviteToken ? t("titleAccept") : t("titleWelcome")}
          </CardTitle>

          <CardDescription className="mt-1 text-sm text-muted-foreground">
            {inviteToken ? t("descAccept") : t("descWelcome")}
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-0">
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive animate-in fade-in zoom-in-95">
                {error}
              </div>
            )}

            {/* Email Field */}
            <div className="flex flex-col gap-1.5">
              <Label
                htmlFor="email"
                className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {t("emailLabel")}
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  type="email"
                  placeholder={t("emailPlaceholder")}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="h-11 rounded-xl border-border/80 bg-muted/40 pl-10 text-foreground placeholder:text-muted-foreground/60 transition-all focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/20"
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label
                  htmlFor="password"
                  className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                >
                  {t("passwordLabel")}
                </Label>
                <Link
                  href="/forgot-password"
                  className="text-xs font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                  {t("forgotPassword")}
                </Link>
              </div>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("passwordPlaceholder")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="h-11 rounded-xl border-border/80 bg-muted/40 pl-10 pr-10 text-foreground placeholder:text-muted-foreground/60 transition-all focus-visible:border-emerald-500/60 focus-visible:ring-emerald-500/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-300 animate-in fade-in slide-in-from-top-1">
                <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                <span>
                  <strong>System Administrator mode:</strong> Logging in will open the separate <strong>Admin Portal</strong>.
                </span>
              </div>
            )}

            {/* Sign In CTA Button */}
            <Button
              type="submit"
              disabled={loading}
              className="mt-2 h-11 w-full rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 transition-all hover:from-emerald-400 hover:to-emerald-500 hover:shadow-emerald-500/35 active:scale-[0.99] disabled:opacity-50"
            >
              {loading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{t("signingIn")}</span>
                </div>
              ) : isAdmin ? (
                <span>Open Admin Portal</span>
              ) : (
                <span>{t("signIn")}</span>
              )}
            </Button>
          </form>

          {/* Trust Security Footer Notice (Create Account option is hidden) */}
          <div className="mt-6 flex items-center justify-center gap-2 border-t border-border/40 pt-4 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400/80" />
            <span>Secure WhatsApp CRM Workspace</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
