"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  UserPlus,
  Copy,
  Check,
  Sparkles,
  KeyRound,
  ShieldCheck,
  Building2,
  Mail,
  User,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

interface OnboardCustomerDialogProps {
  onCustomerCreated: () => void;
}

export function OnboardCustomerDialog({
  onCustomerCreated,
}: OnboardCustomerDialogProps) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [emailOrUsername, setEmailOrUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Success state with generated credentials
  const [createdData, setCreatedData] = useState<{
    fullName: string;
    email: string;
    companyName: string;
    password: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Generate secure random password
  const generatePassword = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
    let generated = "";
    for (let i = 0; i < 10; i++) {
      generated += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPassword(generated);
  };

  const handleReset = () => {
    setFullName("");
    setCompanyName("");
    setEmailOrUsername("");
    setPassword("");
    setError(null);
    setCreatedData(null);
    setCopied(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/admin/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName,
          companyName,
          emailOrUsername,
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to onboard customer");
      }

      setCreatedData({
        fullName: data.user.fullName,
        email: data.user.email,
        companyName: data.user.companyName,
        password: password,
      });

      toast.success("Customer onboarded successfully without email verification!");
      onCustomerCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const copyCredentials = () => {
    if (!createdData) return;
    const loginUrl = typeof window !== "undefined" ? `${window.location.origin}/login` : "/login";
    const text = `Welcome to WhatsApp CRM! Here are your workspace credentials:\n\n• Login URL: ${loginUrl}\n• Email/Username: ${createdData.email}\n• Password: ${createdData.password}\n• Workspace: ${createdData.companyName}\n\nYour account is pre-verified and ready to sign in immediately.`;

    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Credentials copied to clipboard!");
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) handleReset();
      }}
    >
      <DialogTrigger
        render={
          <Button className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg shadow-emerald-600/20 font-medium">
            <UserPlus className="h-4 w-4" />
            Onboard New Customer
          </Button>
        }
      />

      <DialogContent className="max-w-md border-border bg-card/95 backdrop-blur-xl sm:max-w-lg">
        {!createdData ? (
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <div className="flex items-center gap-2 text-emerald-400">
                <ShieldCheck className="h-5 w-5" />
                <span className="text-xs font-semibold uppercase tracking-wider">
                  Admin Customer Provisioning
                </span>
              </div>
              <DialogTitle className="text-xl font-bold text-foreground">
                Onboard New Customer
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Provision a dedicated workspace and credentials. Email verification is{" "}
                <span className="font-semibold text-emerald-400">not required</span>;
                the customer can sign in instantly.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 flex flex-col gap-4">
              {error && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-400">
                  {error}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="custFullName" className="text-sm font-medium">
                  Customer / Owner Full Name <span className="text-red-400">*</span>
                </Label>
                <div className="relative">
                  <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="custFullName"
                    placeholder="e.g. Michael Scott"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    className="pl-9 bg-muted/50 border-border"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="custCompany" className="text-sm font-medium">
                  Company / Workspace Name
                </Label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="custCompany"
                    placeholder="e.g. Dunder Mifflin Paper"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className="pl-9 bg-muted/50 border-border"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Leave blank to default to customer name workspace.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="custEmail" className="text-sm font-medium">
                  Custom Email or Username <span className="text-red-400">*</span>
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="custEmail"
                    placeholder="e.g. client@company.com or acme_sales"
                    value={emailOrUsername}
                    onChange={(e) => setEmailOrUsername(e.target.value)}
                    required
                    className="pl-9 bg-muted/50 border-border"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Accepts standard emails or custom usernames (auto-mapped).
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="custPass" className="text-sm font-medium">
                    Initial Password <span className="text-red-400">*</span>
                  </Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={generatePassword}
                    className="h-6 gap-1 px-1.5 text-xs text-emerald-400 hover:text-emerald-300"
                  >
                    <Sparkles className="h-3 w-3" />
                    Generate
                  </Button>
                </div>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="custPass"
                    type="text"
                    placeholder="Minimum 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={6}
                    className="pl-9 font-mono bg-muted/50 border-border text-foreground"
                  />
                </div>
              </div>
            </div>

            <DialogFooter className="mt-6 gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={loading}
                className="bg-emerald-600 hover:bg-emerald-500 text-white min-w-28"
              >
                {loading ? "Onboarding..." : "Create Customer"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col items-center text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 ring-4 ring-emerald-500/10">
              <Check className="h-6 w-6" />
            </div>

            <DialogTitle className="mt-4 text-xl font-bold text-foreground">
              Customer Ready for Login!
            </DialogTitle>
            <DialogDescription className="mt-1 text-sm text-muted-foreground">
              Workspace and account provisioned. Email is auto-verified.
            </DialogDescription>

            <div className="mt-5 w-full rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 text-left font-mono text-sm">
              <div className="flex flex-col gap-2">
                <div className="flex justify-between border-b border-border/40 pb-2">
                  <span className="text-muted-foreground">Customer:</span>
                  <span className="font-semibold text-foreground">
                    {createdData.fullName}
                  </span>
                </div>
                <div className="flex justify-between border-b border-border/40 pb-2">
                  <span className="text-muted-foreground">Workspace:</span>
                  <span className="text-foreground">{createdData.companyName}</span>
                </div>
                <div className="flex justify-between border-b border-border/40 pb-2">
                  <span className="text-muted-foreground">Login Email:</span>
                  <span className="text-emerald-400 font-semibold selection:bg-emerald-500/30">
                    {createdData.email}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Password:</span>
                  <span className="text-emerald-400 font-semibold">
                    {createdData.password}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                onClick={copyCredentials}
                className="flex-1 gap-2 bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied!" : "Copy Login Credentials"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  handleReset();
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
