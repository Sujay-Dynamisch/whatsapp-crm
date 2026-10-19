"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  User,
  Mail,
  Building,
  Crown,
  Shield,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  ToggleRight,
  Trash2,
  Sparkles,
  RefreshCw,
  Copy,
  Check,
  Lock,
  Unlock,
  Users,
  MessageSquare,
  Radio,
  Eye,
  EyeOff,
  Save,
  Phone,
  Clock,
  Calendar,
  ShieldCheck,
  Activity,
  Layers,
  ChevronRight,
  ShieldAlert,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { SYSTEM_ADMIN_EMAIL } from "@/lib/auth/admin";
import {
  FEATURE_INFO,
  FEATURES,
  isFeatureEnabled,
  type Feature,
} from "@/lib/features";
import type { AccountRole } from "@/lib/auth/roles";

export interface DetailedUserProfile {
  user: {
    id: string;
    email: string;
    fullName: string;
    avatarUrl: string | null;
    accountRole: string;
    systemRole: string;
    emailConfirmed: boolean;
    emailConfirmedAt: string | null;
    createdAt: string;
    lastSignInAt: string | null;
    bannedUntil: string | null;
    isBanned: boolean;
    phone: string | null;
    phoneConfirmedAt: string | null;
    userMetadata: Record<string, unknown>;
    appMetadata: Record<string, unknown>;
  };
  account: {
    id: string;
    name: string;
    ownerUserId: string;
    createdAt: string;
    disabledFeatures: Feature[];
  } | null;
  stats: {
    contactsCount: number;
    conversationsCount: number;
    broadcastsCount: number;
    teamMembersCount: number;
  };
  whatsapp: {
    id: string;
    phone_number_id: string;
    waba_id: string | null;
    status: string;
    connected_at: string | null;
    created_at: string;
  } | null;
  teamMembers: Array<{
    id: string;
    user_id: string;
    full_name: string;
    email: string;
    account_role: string;
    role: string;
    created_at: string;
    avatar_url?: string | null;
  }>;
}

interface UserProfileSheetProps {
  userId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUserUpdated?: () => void;
  onUserDeleted?: () => void;
}

export function UserProfileSheet({
  userId,
  open,
  onOpenChange,
  onUserUpdated,
  onUserDeleted,
}: UserProfileSheetProps) {
  const [profileData, setProfileData] = useState<DetailedUserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Form states
  const [editFullName, setEditFullName] = useState("");
  const [editAccountName, setEditAccountName] = useState("");
  const [editAccountRole, setEditAccountRole] = useState<AccountRole>("owner");
  const [savingProfile, setSavingProfile] = useState(false);

  // Feature states
  const [disabledFeatures, setDisabledFeatures] = useState<Feature[]>([]);
  const [savingFeatures, setSavingFeatures] = useState(false);

  // Password reset state
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  // Suspend state
  const [suspendingUser, setSuspendingUser] = useState(false);

  // Delete modal state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletingUser, setDeletingUser] = useState(false);

  const isSystemAdminUser =
    profileData?.user.email.toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase() ||
    profileData?.user.systemRole === "admin";

  const fetchFullProfile = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load user profile");
      }
      setProfileData(data);
      setEditFullName(data.user.fullName || "");
      setEditAccountName(data.account?.name || "");
      setEditAccountRole((data.user.accountRole as AccountRole) || "owner");
      setDisabledFeatures(data.account?.disabledFeatures || []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error fetching user");
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (open && userId) {
      fetchFullProfile();
      setNewPassword("");
    } else {
      setProfileData(null);
    }
  }, [open, userId, fetchFullProfile]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleSaveProfile = async () => {
    if (!userId) return;
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: editFullName,
          accountName: editAccountName,
          accountRole: editAccountRole,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update profile");
      }

      toast.success("User profile and account updated successfully!");
      fetchFullProfile();
      onUserUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleVerifyEmail = async () => {
    if (!userId) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailConfirm: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to confirm email");
      }
      toast.success("User email marked as verified!");
      fetchFullProfile();
      onUserUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error confirming email");
    }
  };

  const handleToggleSuspend = async () => {
    if (!userId || !profileData) return;
    const nextBanned = !profileData.user.isBanned;
    setSuspendingUser(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isBanned: nextBanned }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update suspension status");
      }
      toast.success(
        nextBanned
          ? "User account suspended successfully."
          : "User account reactivated successfully."
      );
      fetchFullProfile();
      onUserUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error updating suspension");
    } finally {
      setSuspendingUser(false);
    }
  };

  const handleResetPassword = async () => {
    if (!userId || !newPassword || newPassword.length < 6) {
      toast.error("Password must be at least 6 characters.");
      return;
    }
    setSavingPassword(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to set new password");
      }
      toast.success("New password applied successfully!");
      setNewPassword("");
      fetchFullProfile();
      onUserUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error resetting password");
    } finally {
      setSavingPassword(false);
    }
  };

  const generateRandomPassword = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
    let gen = "";
    for (let i = 0; i < 12; i++) {
      gen += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setNewPassword(gen);
    setShowPassword(true);
  };

  const toggleFeature = (feature: Feature, on: boolean) => {
    setDisabledFeatures((prev) =>
      on ? prev.filter((f) => f !== feature) : [...prev, feature]
    );
  };

  const handleSaveFeatures = async () => {
    if (!userId) return;
    setSavingFeatures(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabledFeatures }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to save features");
      }
      toast.success("Feature permissions updated successfully!");
      fetchFullProfile();
      onUserUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update features");
    } finally {
      setSavingFeatures(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!userId) return;
    setDeletingUser(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to delete user");
      }
      toast.success("User account deleted permanently.");
      setDeleteDialogOpen(false);
      onOpenChange(false);
      onUserDeleted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error deleting user");
    } finally {
      setDeletingUser(false);
    }
  };

  const blockedBy = (feature: Feature): Feature | undefined =>
    FEATURES.find(
      (parent) =>
        FEATURE_INFO[parent].implies?.includes(feature) &&
        disabledFeatures.includes(parent)
    );

  const getInitials = (name?: string, email?: string) => {
    if (name && name.trim().length > 0) {
      const parts = name.trim().split(" ");
      return parts.length > 1
        ? (parts[0][0] + parts[1][0]).toUpperCase()
        : name.slice(0, 2).toUpperCase();
    }
    if (email && email.length > 0) {
      return email.slice(0, 2).toUpperCase();
    }
    return "U";
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="border-l border-border/80 bg-background/95 backdrop-blur-2xl text-foreground data-[side=right]:w-full data-[side=right]:sm:max-w-none lg:data-[side=right]:w-[min(1120px,92vw)] p-0 gap-0 flex flex-col h-full overflow-hidden shadow-2xl"
        >
          {loading || !profileData ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 p-8">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm font-medium text-muted-foreground animate-pulse">
                Loading profile & controls...
              </p>
            </div>
          ) : (
            <div className="flex flex-col h-full overflow-hidden">
              {/* Header Banner */}
              <div className="relative overflow-hidden border-b border-border/60 bg-gradient-to-br from-card via-card to-primary/10 px-4 py-5 sm:px-8 sm:py-6">
                <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-primary/20 blur-3xl" />
                <div className="pointer-events-none absolute -bottom-32 left-1/3 h-64 w-64 rounded-full bg-violet-500/10 blur-3xl" />
                <div className="relative flex items-start justify-between gap-4 pr-10">
                  <div className="flex min-w-0 items-center gap-4">
                    {/* Avatar with gradient glow */}
                    <div className="relative flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-primary/30 via-primary/10 to-violet-500/20 border border-primary/30 text-primary font-bold text-lg shadow-inner">
                      {getInitials(
                        profileData.user.fullName,
                        profileData.user.email
                      )}
                      {profileData.user.emailConfirmed && (
                        <div
                          className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white shadow-sm ring-2 ring-background"
                          title="Verified Account"
                        >
                          <Check className="h-3 w-3 stroke-[3]" />
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground truncate">
                          {profileData.user.fullName || "Unnamed User"}
                        </h2>
                        {isSystemAdminUser && (
                          <Badge className="bg-red-500/15 border-red-500/30 text-red-400 gap-1 text-[11px] font-semibold">
                            <Shield className="h-3 w-3" /> System Admin
                          </Badge>
                        )}
                        {profileData.user.isBanned && (
                          <Badge className="bg-red-500/20 border-red-500/40 text-red-400 gap-1 text-[11px]">
                            <Lock className="h-3 w-3" /> Suspended
                          </Badge>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground font-mono truncate">
                          {profileData.user.email}
                        </span>
                        <button
                          onClick={() =>
                            copyToClipboard(profileData.user.email, "email")
                          }
                          className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
                          title="Copy email"
                        >
                          {copiedKey === "email" ? (
                            <Check className="h-3.5 w-3.5 text-emerald-400" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        {/* Account role badge */}
                        <Badge
                          variant="outline"
                          className="gap-1 text-[11px] font-medium bg-card/60"
                        >
                          <Crown className="h-3 w-3 text-amber-400" />
                          {profileData.user.accountRole.toUpperCase()}
                        </Badge>

                        {/* Verification badge */}
                        {profileData.user.emailConfirmed ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="h-3 w-3" /> Verified
                          </span>
                        ) : (
                          <button
                            onClick={handleVerifyEmail}
                            className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 text-[11px] font-medium text-amber-400 border border-amber-500/30 transition-colors cursor-pointer"
                            title="Click to manually verify email"
                          >
                            <AlertCircle className="h-3 w-3" /> Unconfirmed (Click to Verify)
                          </button>
                        )}

                        {/* Workspace pill */}
                        {profileData.account && (
                          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Building className="h-3 w-3" />
                            {profileData.account.name}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Header Actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={fetchFullProfile}
                      disabled={loading}
                      className="h-8 w-8 p-0"
                      title="Refresh"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                      />
                    </Button>
                  </div>
                </div>

                {/* KPI Strip */}
                <div className="relative grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
                  <div className="min-w-0 rounded-xl border border-border/50 bg-card/40 px-3.5 py-3 backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card/60">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="h-3.5 w-3.5 text-primary" />
                      Contacts
                    </div>
                    <div className="text-xl font-bold tabular-nums text-foreground mt-1">
                      {profileData.stats.contactsCount.toLocaleString()}
                    </div>
                  </div>

                  <div className="min-w-0 rounded-xl border border-border/50 bg-card/40 px-3.5 py-3 backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card/60">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MessageSquare className="h-3.5 w-3.5 text-blue-400" />
                      Conversations
                    </div>
                    <div className="text-xl font-bold tabular-nums text-foreground mt-1">
                      {profileData.stats.conversationsCount.toLocaleString()}
                    </div>
                  </div>

                  <div className="min-w-0 rounded-xl border border-border/50 bg-card/40 px-3.5 py-3 backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card/60">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Radio className="h-3.5 w-3.5 text-violet-400" />
                      Broadcasts
                    </div>
                    <div className="text-xl font-bold tabular-nums text-foreground mt-1">
                      {profileData.stats.broadcastsCount.toLocaleString()}
                    </div>
                  </div>

                  <div className="min-w-0 rounded-xl border border-border/50 bg-card/40 px-3.5 py-3 backdrop-blur-sm transition-colors hover:border-primary/40 hover:bg-card/60">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Activity className="h-3.5 w-3.5 text-emerald-400" />
                      WhatsApp
                    </div>
                    <div className="text-xs font-semibold mt-1">
                      {profileData.whatsapp?.status === "connected" ? (
                        <span className="text-emerald-400 font-bold flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Connected
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Disconnected</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* Navigation Tabs */}
              <Tabs
                defaultValue="profile"
                className="flex-1 flex flex-col min-h-0 overflow-hidden"
              >
                <div className="px-4 sm:px-8 py-3 border-b border-border/50 bg-card/30">
                  <TabsList className="w-full bg-card/70 border border-border/60 p-1 rounded-xl h-auto grid grid-cols-2 md:grid-cols-4 gap-1">
                    <TabsTrigger
                      value="profile"
                      className="w-full justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap data-active:bg-primary data-active:shadow-md data-active:shadow-primary/20 data-active:text-primary-foreground transition-all"
                    >
                      <User className="h-3.5 w-3.5" />
                      Profile & Roles
                    </TabsTrigger>
                    <TabsTrigger
                      value="workspace"
                      className="w-full justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap data-active:bg-primary data-active:shadow-md data-active:shadow-primary/20 data-active:text-primary-foreground transition-all"
                    >
                      <Building className="h-3.5 w-3.5" />
                      Workspace
                    </TabsTrigger>
                    <TabsTrigger
                      value="features"
                      className="w-full justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap data-active:bg-primary data-active:shadow-md data-active:shadow-primary/20 data-active:text-primary-foreground transition-all"
                    >
                      <ToggleRight className="h-3.5 w-3.5" />
                      Features & Gates
                    </TabsTrigger>
                    <TabsTrigger
                      value="security"
                      className="w-full justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg whitespace-nowrap data-active:bg-primary data-active:shadow-md data-active:shadow-primary/20 data-active:text-primary-foreground transition-all"
                    >
                      <Lock className="h-3.5 w-3.5" />
                      Security & Controls
                    </TabsTrigger>
                  </TabsList>
                </div>

                {/* TAB 1: Profile & Roles */}
                <TabsContent
                  value="profile"
                  className="flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6 space-y-6"
                >
                  {/* Edit Profile Form */}
                  <div className="rounded-2xl border border-border/60 bg-card/50 p-5 backdrop-blur-sm space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-sm font-bold text-foreground">
                          Account Profile Information
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Manage full name, workspace name, and assigned permissions
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={handleSaveProfile}
                        disabled={savingProfile}
                        className="gap-1.5 h-8 bg-primary"
                      >
                        <Save className="h-3.5 w-3.5" />
                        {savingProfile ? "Saving..." : "Save Changes"}
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="editFullName" className="text-xs font-medium">
                          Full Name
                        </Label>
                        <Input
                          id="editFullName"
                          value={editFullName}
                          onChange={(e) => setEditFullName(e.target.value)}
                          placeholder="User full name"
                          className="bg-card border-border/70"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="editEmail" className="text-xs font-medium">
                          Email Address
                        </Label>
                        <Input
                          id="editEmail"
                          value={profileData.user.email}
                          disabled
                          className="bg-muted/50 text-muted-foreground border-border/50 font-mono text-xs"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="editAccountName" className="text-xs font-medium">
                          Workspace / Organization Name
                        </Label>
                        <Input
                          id="editAccountName"
                          value={editAccountName}
                          onChange={(e) => setEditAccountName(e.target.value)}
                          placeholder="Workspace name"
                          className="bg-card border-border/70"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <Label htmlFor="editRole" className="text-xs font-medium">
                          Workspace Role
                        </Label>
                        <select
                          id="editRole"
                          value={editAccountRole}
                          onChange={(e) =>
                            setEditAccountRole(e.target.value as AccountRole)
                          }
                          className="flex h-9 w-full rounded-md border border-border/70 bg-card px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring text-foreground"
                        >
                          <option value="owner">Workspace Owner (Full Control)</option>
                          <option value="admin">Administrator (Settings & Team)</option>
                          <option value="agent">Agent (Conversations & Contacts)</option>
                          <option value="viewer">Viewer (Read-only)</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Metadata & Identification Grid */}
                  <div className="rounded-2xl border border-border/60 bg-card/50 p-5 space-y-3">
                    <h3 className="text-sm font-bold text-foreground">
                      Platform Identifiers & Activity
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      <div className="flex flex-col gap-1 rounded-xl bg-background/50 border border-border/40 p-3">
                        <span className="text-muted-foreground font-medium flex items-center gap-1">
                          User ID (auth.users)
                        </span>
                        <div className="flex items-center justify-between gap-1 font-mono text-foreground">
                          <span className="truncate">{profileData.user.id}</span>
                          <button
                            onClick={() =>
                              copyToClipboard(profileData.user.id, "uid")
                            }
                            className="p-1 hover:text-primary transition-colors shrink-0"
                            title="Copy ID"
                          >
                            {copiedKey === "uid" ? (
                              <Check className="h-3 w-3 text-emerald-400" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-1 rounded-xl bg-background/50 border border-border/40 p-3">
                        <span className="text-muted-foreground font-medium flex items-center gap-1">
                          Account ID (Tenant)
                        </span>
                        <div className="flex items-center justify-between gap-1 font-mono text-foreground">
                          <span className="truncate">
                            {profileData.account?.id || "N/A"}
                          </span>
                          {profileData.account?.id && (
                            <button
                              onClick={() =>
                                copyToClipboard(profileData.account!.id, "accid")
                              }
                              className="p-1 hover:text-primary transition-colors shrink-0"
                              title="Copy ID"
                            >
                              {copiedKey === "accid" ? (
                                <Check className="h-3 w-3 text-emerald-400" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col gap-1 rounded-xl bg-background/50 border border-border/40 p-3">
                        <span className="text-muted-foreground font-medium flex items-center gap-1">
                          <Calendar className="h-3 w-3" /> Account Created
                        </span>
                        <span className="text-foreground font-medium">
                          {format(
                            new Date(profileData.user.createdAt),
                            "PPpp"
                          )}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1 rounded-xl bg-background/50 border border-border/40 p-3">
                        <span className="text-muted-foreground font-medium flex items-center gap-1">
                          <Clock className="h-3 w-3" /> Last Active Sign-In
                        </span>
                        <span className="text-foreground font-medium">
                          {profileData.user.lastSignInAt
                            ? format(
                                new Date(profileData.user.lastSignInAt),
                                "PPpp"
                              )
                            : "Never signed in"}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Password Quick Reset */}
                  <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-card/80 to-primary/5 p-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-foreground font-bold text-sm">
                        <KeyRound className="h-4 w-4 text-primary" />
                        Direct Password Reset
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={generateRandomPassword}
                        className="h-7 text-xs text-emerald-400 gap-1 px-2"
                      >
                        <Sparkles className="h-3 w-3" /> Generate Password
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Set a new password immediately for this user without triggering email confirmation.
                    </p>

                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Input
                          type={showPassword ? "text" : "password"}
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Enter at least 6 characters"
                          className="font-mono text-xs pr-9 bg-card border-border/70"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-2.5 top-2.5 text-muted-foreground hover:text-foreground"
                        >
                          {showPassword ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>

                      <Button
                        size="sm"
                        onClick={handleResetPassword}
                        disabled={savingPassword || newPassword.length < 6}
                        className="bg-primary text-xs shrink-0"
                      >
                        {savingPassword ? "Updating..." : "Apply Password"}
                      </Button>
                    </div>
                  </div>
                </TabsContent>

                {/* TAB 2: Workspace & Team */}
                <TabsContent
                  value="workspace"
                  className="flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6 space-y-6"
                >
                  {/* WhatsApp Integration Card */}
                  <div className="rounded-2xl border border-border/60 bg-card/50 p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                          <Activity className="h-4 w-4" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-foreground">
                            Meta WhatsApp Cloud API
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            Account connectivity and business phone number status
                          </p>
                        </div>
                      </div>

                      <Badge
                        className={
                          profileData.whatsapp?.status === "connected"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                            : "border-border bg-muted/40 text-muted-foreground"
                        }
                      >
                        {profileData.whatsapp?.status === "connected"
                          ? "Connected"
                          : "Not Configured"}
                      </Badge>
                    </div>

                    {profileData.whatsapp ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs pt-1">
                        <div className="rounded-xl border border-border/40 bg-background/40 p-3">
                          <span className="text-muted-foreground block">
                            Phone Number ID
                          </span>
                          <span className="font-mono font-medium text-foreground text-xs mt-1 block">
                            {profileData.whatsapp.phone_number_id}
                          </span>
                        </div>

                        <div className="rounded-xl border border-border/40 bg-background/40 p-3">
                          <span className="text-muted-foreground block">
                            WABA ID
                          </span>
                          <span className="font-mono font-medium text-foreground text-xs mt-1 block">
                            {profileData.whatsapp.waba_id || "None"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground">
                        This customer has not connected their WhatsApp Business Account yet.
                      </div>
                    )}
                  </div>

                  {/* Team Members List */}
                  <div className="rounded-2xl border border-border/60 bg-card/50 p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-bold text-foreground">
                          Workspace Team Members ({profileData.teamMembers.length})
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          All platform users associated with {profileData.account?.name || "this account"}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-2">
                      {profileData.teamMembers.map((member) => (
                        <div
                          key={member.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-border/40 bg-background/40 p-3"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 text-primary font-bold text-xs">
                              {getInitials(member.full_name, member.email)}
                            </div>
                            <div className="flex flex-col min-w-0">
                              <span className="text-xs font-bold text-foreground truncate">
                                {member.full_name || "Unnamed Member"}
                              </span>
                              <span className="text-[11px] text-muted-foreground font-mono truncate">
                                {member.email}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <Badge
                              variant="outline"
                              className="text-[10px] uppercase font-semibold"
                            >
                              {member.account_role}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </TabsContent>

                {/* TAB 3: Features & Gates */}
                <TabsContent
                  value="features"
                  className="flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        Platform Feature Entitlements
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Enable or disable individual capabilities for{" "}
                        <span className="font-semibold text-foreground">
                          {profileData.account?.name || "this tenant"}
                        </span>
                      </p>
                    </div>

                    <Button
                      size="sm"
                      onClick={handleSaveFeatures}
                      disabled={savingFeatures || !profileData.account}
                      className="gap-1.5 h-8 bg-primary"
                    >
                      <Save className="h-3.5 w-3.5" />
                      {savingFeatures ? "Saving..." : "Save Features"}
                    </Button>
                  </div>

                  <div className="space-y-2">
                    {FEATURES.map((feature) => {
                      const parent = blockedBy(feature);
                      const isEnabled = isFeatureEnabled(disabledFeatures, feature);
                      const info = FEATURE_INFO[feature];

                      return (
                        <div
                          key={feature}
                          className={`flex items-center justify-between gap-4 rounded-xl border p-3.5 transition-colors ${
                            isEnabled
                              ? "border-border/70 bg-card/60"
                              : "border-border/30 bg-muted/20 opacity-70"
                          }`}
                        >
                          <div className="flex-1 pr-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-foreground">
                                {info.label}
                              </span>
                              {parent && (
                                <span className="text-[10px] text-amber-400 font-medium">
                                  (Blocked by {FEATURE_INFO[parent].label})
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground mt-0.5">
                              {info.description}
                            </p>
                          </div>

                          <Switch
                            checked={isEnabled}
                            disabled={savingFeatures || Boolean(parent)}
                            onCheckedChange={(checked) =>
                              toggleFeature(feature, checked)
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </TabsContent>

                {/* TAB 4: Security & Controls */}
                <TabsContent
                  value="security"
                  className="flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6 space-y-6"
                >
                  {/* Account Suspension Control */}
                  <div className="rounded-2xl border border-border/60 bg-card/50 p-5 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={`flex h-9 w-9 items-center justify-center rounded-xl border ${
                            profileData.user.isBanned
                              ? "bg-red-500/10 border-red-500/30 text-red-400"
                              : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                          }`}
                        >
                          {profileData.user.isBanned ? (
                            <Lock className="h-4 w-4" />
                          ) : (
                            <Unlock className="h-4 w-4" />
                          )}
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-foreground">
                            Account Access Status
                          </h3>
                          <p className="text-xs text-muted-foreground">
                            {profileData.user.isBanned
                              ? "User is currently suspended from signing in."
                              : "User account is active and able to sign in."}
                          </p>
                        </div>
                      </div>

                      {!isSystemAdminUser && (
                        <Button
                          variant={profileData.user.isBanned ? "outline" : "secondary"}
                          size="sm"
                          onClick={handleToggleSuspend}
                          disabled={suspendingUser}
                          className="h-8 gap-1.5 text-xs font-semibold"
                        >
                          {profileData.user.isBanned ? (
                            <>
                              <Unlock className="h-3.5 w-3.5 text-emerald-400" />
                              Reactivate Account
                            </>
                          ) : (
                            <>
                              <Lock className="h-3.5 w-3.5 text-red-400" />
                              Suspend Account
                            </>
                          )}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Danger Zone */}
                  <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 space-y-4">
                    <div className="flex items-center gap-2 text-red-400 font-bold text-sm">
                      <ShieldAlert className="h-4 w-4" />
                      Danger Zone
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Permanently delete this user account. If this user is the primary workspace owner, their associated tenant workspace, WhatsApp contacts, conversations, and pipeline data will also be removed. This action cannot be undone.
                    </p>

                    <div className="pt-1">
                      {isSystemAdminUser ? (
                        <p className="text-xs text-red-400 font-medium">
                          The system administrator account is protected and cannot be deleted.
                        </p>
                      ) : (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeleteDialogOpen(true)}
                          className="gap-1.5 h-8 text-xs font-semibold"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Permanently Delete User Account
                        </Button>
                      )}
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Delete User Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm border-border bg-card/95 backdrop-blur-xl">
          <DialogHeader>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-red-500/15 border border-red-500/30 text-red-400 mb-2">
              <ShieldAlert className="h-6 w-6" />
            </div>
            <DialogTitle className="text-lg font-bold text-foreground">
              Delete User Account
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Are you sure you want to permanently delete{" "}
              <span className="font-semibold text-foreground">
                {profileData?.user.email}
              </span>
              ? All associated data, contacts, and settings will be purged.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4 gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deletingUser}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={deletingUser}
            >
              {deletingUser ? "Deleting..." : "Confirm Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
