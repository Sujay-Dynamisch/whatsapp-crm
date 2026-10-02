/**
 * System Admin identification and permission predicates.
 *
 * System administrators manage the platform across all customer tenants,
 * onboard new clients, and manage user accounts.
 */

export const SYSTEM_ADMIN_EMAIL = "admin@gmail.com";

/**
 * Returns true if the user matches the system admin email or possesses
 * a system-level 'admin' or 'superadmin' role in their profile.
 */
export function isSystemAdmin(
  email?: string | null,
  role?: string | null
): boolean {
  if (!email && !role) return false;
  if (email && email.trim().toLowerCase() === SYSTEM_ADMIN_EMAIL.toLowerCase()) {
    return true;
  }
  if (role && (role === "admin" || role === "superadmin")) {
    return true;
  }
  return false;
}
