// hooks/usePermissions.ts
import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useDataStore } from '@/store/dataStore';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Ionicons } from '@expo/vector-icons';

export interface PagePermission {
  id?: number;
  user_id: number;
  page_name: string;
  is_enabled: boolean;
  sort_order: number;
}

// ── Master page registry ──────────────────────────────────────────────────────
export const ALL_PAGES = [
 { name: 'index',             label: 'Delivery',           icon: 'cart-outline'          as const, color: '#017DC5', defaultSort: 1  }, // BPCL Blue
  { name: 'transactionscreen', label: 'Transact',           icon: 'wallet-outline'        as const, color: '#10b981', defaultSort: 2  }, // Emerald Green
  { name: 'commercial',        label: 'Commercial',         icon: 'business-outline'      as const, color: '#ef4444', defaultSort: 3  }, // Bright Red
  { name: 'stock',             label: 'Stock',              icon: 'cube-outline'          as const, color: '#f59e0b', defaultSort: 4  }, // Amber
  { name: 'online',            label: 'Online',             icon: 'globe-outline'         as const, color: '#8b5cf6', defaultSort: 5  }, // Violet
  { name: 'summary',           label: 'Stock Summary',      icon: 'analytics-outline'     as const, color: '#a855f7', defaultSort: 6  }, // Purple
  { name: 'records',           label: 'Daily Records',      icon: 'calendar-outline'      as const, color: '#059669', defaultSort: 7  }, // Dark Emerald
  { name: 'totals',            label: 'Totals',             icon: 'calculator-outline'    as const, color: '#ea580c', defaultSort: 8  }, // Deep Orange
  { name: 'pfsheet',           label: 'PF Sheet',           icon: 'newspaper-outline'     as const, color: '#dc2626', defaultSort: 9  }, // Crimson
  { name: 'weeklysalary',      label: 'Weekly Salary',      icon: 'cash-outline'          as const, color: '#0d9488', defaultSort: 10 }, // Teal
  { name: 'paymentpending',    label: 'Payment Pending',    icon: 'hourglass-outline'     as const, color: '#d97706', defaultSort: 11 }, // Warm Amber
  { name: 'emptypending',      label: 'Empty Pending',      icon: 'sync-outline'          as const, color: '#475569', defaultSort: 12 }, // Slate (cylinder cycle)
  { name: 'settings',          label: 'Settings',           icon: 'settings-outline'      as const, color: '#64748b', defaultSort: 99 }, // Gray
  { name: 'commercial-payment', label: 'Bank Payment',      icon: 'card-outline'          as const, color: '#2563eb', defaultSort: 13 }, // Royal Blue
  { name: 'complaint',          label: 'Register Complaint', icon: 'alert-circle-outline'  as const, color: '#e11d48', defaultSort: 14 }, // Rose Red
  { name: 'active-complaints',  label: 'Active Complaints',  icon: 'construct-outline'     as const, color: '#06b6d4', defaultSort: 15 }, // Cyan (work in progress)
  { name: 'callingrecordsscreen',  label: 'Calling',        icon: 'call-outline'          as const, color: '#0284c7', defaultSort: 16 }, // Sky Blue
  { name: 'deliveryrecordstab',  label: 'Delivery Done Records', icon: 'checkmark-done-circle-outline' as const, color: '#10b981', defaultSort: 17 }, // Mint Green (completed)
  { name: 'godownentries',      label: 'Go-Down Entries',     icon: 'home-outline'          as const, color: '#4f46e5', defaultSort: 18 }, // Indigo (warehouse structure)
  { name: 'sachinReviewStore',  label: 'Review Daily Records', icon: 'eye-outline'          as const, color: '#f43f5e', defaultSort: 19 }, // Soft Pink (auditing/viewing)
  { name: 'JDStockScreen',  label: 'JD Stock Screen', icon: 'clipboard-outline'          as const, color: '#f43f5e', defaultSort: 20 }, // Soft Pink (auditing/viewing)
  { name: 'documentscreen', label: 'Documents', icon: 'document-text-outline' as const, color: '#0ea5e9', defaultSort: 21 }, // Sky blue (storage/retrieval)
  { name: 'customerupdate', label: 'Customer Update', icon: 'people-outline' as const, color: '#3b82f6', defaultSort: 22 }, // Blue (customer/people)
  { name: 'fasttagscreen', label: 'Fasttag Sheets', icon: 'car-outline' as const, color: '#f97316', defaultSort: 23 }, // Orange (vehicle/toll)
  { name: 'bankentries', label: 'Online Bank Entries', icon: 'business-outline' as const, color: '#6366f1', defaultSort: 24 }, // Indigo (bank/finance // Green (contact/communication)
    { name: 'whatsappscreen', label: 'EKYC Whatsapp Messages', icon: 'business-outline' as const, color: '#6366f1', defaultSort: 25 }, // Indigo (bank/finance // Green (contact/communication)
]
// ── Admin-only pages — never shown to regular users ───────────────────────────
export const ADMIN_ONLY_PAGES = [
  { name: 'staff', label: 'Staff Access', icon: 'shield-checkmark' as const, color: '#c0392b', defaultSort: 98 },
];

// ── Combined for enrich lookups ───────────────────────────────────────────────
export const ALL_PAGES_INCLUDING_ADMIN = [...ALL_PAGES, ...ADMIN_ONLY_PAGES];

// ── Fetch permissions for a specific user ─────────────────────────────────────
export async function fetchUserPermissions(
  userId: number
): Promise<PagePermission[]> {
  const { data, error } = await supabase
    .from('user_page_permissions')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true });

  if (error) throw error;
  return data || [];
}

// ── Save permissions for a specific user ──────────────────────────────────────
export async function saveUserPermissions(
  userId: number,
  permissions: Omit<PagePermission, 'id'>[]
): Promise<void> {
  const { error: delErr } = await supabase
    .from('user_page_permissions')
    .delete()
    .eq('user_id', userId);

  if (delErr) throw delErr;

  const { error: insErr } = await supabase
    .from('user_page_permissions')
    .insert(permissions.map((p) => ({ ...p, user_id: userId })));

  if (insErr) throw insErr;
}

// ── Hook: load current user's permissions on mount ────────────────────────────
export function useCurrentUserPermissions() {
  const { currentUser, setAllowedPages, setPagePermissions } = useDataStore();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    // No user logged in
    if (!currentUser) {
      setLoading(false);
      return;
    }

    // ✅ Case-insensitive admin check
    const isAdmin = currentUser.username?.toLowerCase() === 'jitesh';

    if (isAdmin) {
      console.log('✅ Jitesh detected — granting ALL permissions including staff');

      // Jitesh gets ALL_PAGES + ADMIN_ONLY_PAGES
      const allPerms = ALL_PAGES_INCLUDING_ADMIN.map((p) => ({
        user_id: currentUser.id,
        page_name: p.name,
        is_enabled: true,
        sort_order: p.defaultSort,
      }));

      setAllowedPages(ALL_PAGES_INCLUDING_ADMIN.map((p) => p.name));
      setPagePermissions(allPerms);
      setLoading(false);
      return;
    }

    // Regular user — fetch from DB
    try {
      const perms = await fetchUserPermissions(currentUser.id);

      if (perms.length === 0) {
        // No permissions set yet → only settings visible
        setAllowedPages(['settings']);
        setPagePermissions([
          {
            user_id: currentUser.id,
            page_name: 'settings',
            is_enabled: true,
            sort_order: 99,
          },
        ]);
      } else {
        const enabled = perms
          .filter((p) => p.is_enabled)
          .map((p) => p.page_name);

        // Settings always included
        if (!enabled.includes('settings')) enabled.push('settings');

        setAllowedPages(enabled);
        setPagePermissions(perms);
      }
    } catch (err) {
      console.error('❌ useCurrentUserPermissions error:', err);
      setAllowedPages(['settings']);
      setPagePermissions([]);
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { loading, reload };
}