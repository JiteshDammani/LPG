import { useDataStore } from '../store/dataStore';

export type Role = 'admin' | 'staff' | 'viewer';

/**
 * Returns the current user's role based on auth_user flags:
 *   is_superuser = true  →  'admin'  (full access)
 *   is_staff     = true  →  'staff'  (can edit, no admin settings)
 *   both false           →  'viewer' (read-only: Summary, Records, Totals)
 */
export function useRole(): Role {
  const { currentUser } = useDataStore();
  if (!currentUser) return 'viewer';
  if (currentUser.is_superuser) return 'admin';
  if (currentUser.is_staff) return 'staff';
  return 'viewer';
}
