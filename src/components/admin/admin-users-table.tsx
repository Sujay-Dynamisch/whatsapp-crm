"use client";

import { useState, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Search,
  MoreVertical,
  KeyRound,
  Trash2,
  CheckCircle2,
  ShieldAlert,
  Building,
  Mail,
  User,
  Crown,
  Shield,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { SYSTEM_ADMIN_EMAIL } from "@/lib/auth/admin";

export interface AdminUserRecord {
  id: string;
  email: string;
  fullName: string;
  accountName: string;
  accountId: string | null;
  accountRole: string;
  systemRole: string;
  emailConfirmed: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

interface AdminUsersTableProps {
  users: AdminUserRecord[];
  loading: boolean;
  onRefresh: () => void;
}

export function AdminUsersTable({
  users,
  loading,
  onRefresh,
}: AdminUsersTableProps) {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");

  // Reset password dialog state
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<AdminUserRecord | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [actionLoading, setActionLoading] = useState(false);

  // Delete user dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Filtered users
  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      const matchesSearch =
        u.email.toLowerCase().includes(search.toLowerCase()) ||
        u.fullName.toLowerCase().includes(search.toLowerCase()) ||
        u.accountName.toLowerCase().includes(search.toLowerCase());

      if (!matchesSearch) return false;

      if (roleFilter === "all") return true;
      if (roleFilter === "verified") return u.emailConfirmed;
      if (roleFilter === "owner") return u.accountRole === "owner";
      if (roleFilter === "admin") return u.accountRole === "admin" || u.systemRole === "admin";
      if (roleFilter === "agent") return u.accountRole === "agent";

      return true;
    });
  }, [users, search, roleFilter]);

  const handleResetPassword = async () => {
    if (!selectedUser || !newPassword || newPassword.length < 6) {
      toast.error("Password must be at least 6 characters.");
      return;
    }

    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update password");
      }

      toast.success(`Password for ${selectedUser.email} updated successfully!`);
      setPasswordDialogOpen(false);
      setNewPassword("");
      setSelectedUser(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error updating password");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!selectedUser) return;

    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${selectedUser.id}`, {
        method: "DELETE",
      });

      const data = await res.json();
      if (!res.ok) {
        const errorMsg =
          typeof data.error === "string"
            ? data.error
            : data.error?.message || "Failed to delete user";
        throw new Error(errorMsg);
      }

      toast.success(`User ${selectedUser.email} deleted successfully.`);
      setDeleteDialogOpen(false);
      setSelectedUser(null);
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Error deleting user");
    } finally {
      setActionLoading(false);
    }
  };

  const generateRandomPassword = () => {
    const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
    let gen = "";
    for (let i = 0; i < 10; i++) {
      gen += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setNewPassword(gen);
  };

  const getRoleBadge = (u: AdminUserRecord) => {
    if (u.email.toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase() || u.systemRole === "admin") {
      return (
        <Badge className="border-red-500/40 bg-red-500/10 text-red-400 gap-1">
          <Shield className="h-3 w-3" /> System Admin
        </Badge>
      );
    }

    switch (u.accountRole) {
      case "owner":
        return (
          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-300 gap-1">
            <Crown className="h-3 w-3" /> Workspace Owner
          </Badge>
        );
      case "admin":
        return (
          <Badge className="border-blue-500/40 bg-blue-500/10 text-blue-400 gap-1">
            <Shield className="h-3 w-3" /> Admin
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground">
            {u.accountRole || "User"}
          </Badge>
        );
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Controls Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by customer name, email, workspace..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-card/60 border-border"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-border bg-card/60 p-1 text-xs">
            {[
              { id: "all", label: "All Users" },
              { id: "verified", label: "Verified" },
              { id: "owner", label: "Owners" },
              { id: "admin", label: "Admins" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setRoleFilter(f.id)}
                className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                  roleFilter === f.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className="h-8 gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Users Data Table */}
      <div className="rounded-xl border border-border bg-card/60 backdrop-blur-md overflow-hidden shadow-sm">
        <Table>
          <TableHeader>
            <TableRow className="border-border/60 hover:bg-transparent">
              <TableHead className="font-semibold text-foreground">User / Customer</TableHead>
              <TableHead className="font-semibold text-foreground">Workspace / Account</TableHead>
              <TableHead className="font-semibold text-foreground">Role</TableHead>
              <TableHead className="font-semibold text-foreground">Status</TableHead>
              <TableHead className="font-semibold text-foreground">Created</TableHead>
              <TableHead className="font-semibold text-foreground">Last Active</TableHead>
              <TableHead className="text-right font-semibold text-foreground">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i} className="border-border/40">
                  <TableCell colSpan={7}>
                    <div className="h-6 w-full animate-pulse rounded bg-muted/40" />
                  </TableCell>
                </TableRow>
              ))
            ) : filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  No users found matching your search.
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map((u) => {
                const isSystemAdminUser =
                  u.email.toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase();

                return (
                  <TableRow
                    key={u.id}
                    className="border-border/40 hover:bg-muted/30 transition-colors"
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 text-primary font-bold text-xs">
                          {u.fullName
                            ? u.fullName.slice(0, 2).toUpperCase()
                            : u.email.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground text-sm flex items-center gap-1.5">
                            {u.fullName}
                            {isSystemAdminUser && (
                              <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                                Super
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-muted-foreground">{u.email}</span>
                        </div>
                      </div>
                    </TableCell>

                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm text-foreground">
                        <Building className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{u.accountName}</span>
                      </div>
                    </TableCell>

                    <TableCell>{getRoleBadge(u)}</TableCell>

                    <TableCell>
                      {u.emailConfirmed ? (
                        <div className="flex items-center gap-1 text-xs text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Verified</span>
                        </div>
                      ) : (
                        <span className="text-xs text-amber-400">Unconfirmed</span>
                      )}
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground">
                      {format(new Date(u.createdAt), "MMM d, yyyy")}
                    </TableCell>

                    <TableCell className="text-xs text-muted-foreground">
                      {u.lastSignInAt
                        ? format(new Date(u.lastSignInAt), "MMM d, HH:mm")
                        : "Never"}
                    </TableCell>

                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuGroup>
                            <DropdownMenuLabel className="text-xs text-muted-foreground">
                              Manage User
                            </DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => {
                                setSelectedUser(u);
                                setNewPassword("");
                                setPasswordDialogOpen(true);
                              }}
                              className="gap-2 cursor-pointer"
                            >
                              <KeyRound className="h-4 w-4 text-primary" />
                              Reset Password
                            </DropdownMenuItem>

                            {!isSystemAdminUser && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onClick={() => {
                                    setSelectedUser(u);
                                    setDeleteDialogOpen(true);
                                  }}
                                  className="gap-2 text-red-400 focus:text-red-400 cursor-pointer"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete User
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Reset Password Dialog */}
      <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
        <DialogContent className="max-w-sm border-border bg-card/95 backdrop-blur-xl">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold">Reset Password</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Set a new password for{" "}
              <span className="font-semibold text-foreground">
                {selectedUser?.email}
              </span>
              . This takes effect immediately.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="resetPass" className="text-sm font-medium">
                New Password
              </Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={generateRandomPassword}
                className="h-6 gap-1 px-1.5 text-xs text-emerald-400"
              >
                <Sparkles className="h-3 w-3" /> Generate
              </Button>
            </div>
            <Input
              id="resetPass"
              type="text"
              placeholder="Minimum 6 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="font-mono text-sm"
            />
          </div>

          <DialogFooter className="mt-4 gap-2">
            <Button
              variant="outline"
              onClick={() => setPasswordDialogOpen(false)}
              disabled={actionLoading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleResetPassword}
              disabled={actionLoading || newPassword.length < 6}
              className="bg-primary"
            >
              {actionLoading ? "Updating..." : "Save Password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm border-border bg-card/95 backdrop-blur-xl">
          <DialogHeader>
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/20 text-red-400 mb-2">
              <ShieldAlert className="h-5 w-5" />
            </div>
            <DialogTitle className="text-lg font-bold text-foreground">
              Delete User Account
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">
              Are you sure you want to permanently delete{" "}
              <span className="font-semibold text-foreground">
                {selectedUser?.email}
              </span>
              ? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter className="mt-4 gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={actionLoading}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={actionLoading}
            >
              {actionLoading ? "Deleting..." : "Delete User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
