// app/(tabs)/staff.tsx
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Switch,
  RefreshControl,
  TextInput,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';
import {
  ALL_PAGES,
  fetchUserPermissions,
  saveUserPermissions,
  PagePermission,
} from '../../hooks/usePermissions';
import { useDataStore } from '@/store/dataStore';

const BPCL_BLUE = '#017DC5';
const ADMIN_USERNAME = 'Jitesh';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AuthUser {
  id: number;
  username: string;
  first_name: string;
  last_name: string;
  is_active: boolean;
}

interface PermissionRow {
  page_name: string;
  is_enabled: boolean;
  sort_order: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDefaultPermissions(userId: number): PermissionRow[] {
  return ALL_PAGES.map((p) => ({
    page_name: p.name,
    is_enabled: false,
    sort_order: p.defaultSort,
  }));
}

function mergeWithDefaults(
  saved: PagePermission[],
  userId: number
): PermissionRow[] {
  const defaults = buildDefaultPermissions(userId);
  return defaults.map((def) => {
    const found = saved.find((s) => s.page_name === def.page_name);
    return found
      ? {
          page_name: found.page_name,
          is_enabled: found.is_enabled,
          sort_order: found.sort_order,
        }
      : def;
  });
}

// ── Section Header ────────────────────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBadge}>
        <Text style={styles.sectionBadgeText}>{count}</Text>
      </View>
    </View>
  );
}

// ── Permission Row ────────────────────────────────────────────────────────────

function PermRow({
  item,
  isSettings,
  onChange,
  onSortChange,
}: {
  item: PermissionRow & { label: string; icon: string; color: string };
  isSettings: boolean;
  onChange: (name: string, val: boolean) => void;
  onSortChange: (name: string, val: number) => void;
}) {
  return (
    <View
      style={[
        styles.permRow,
        isSettings && styles.permRowSettings,
        item.is_enabled && styles.permRowEnabled,
      ]}
    >
      {/* Icon */}
      <View
        style={[
          styles.permIcon,
          { backgroundColor: item.color + '22' },
        ]}
      >
        <Ionicons
          name={item.icon as any}
          size={22}
          color={item.is_enabled ? item.color : '#aaa'}
        />
      </View>

      {/* Label */}
      <View style={styles.permInfo}>
        <Text
          style={[
            styles.permLabel,
            item.is_enabled && { color: '#222' },
          ]}
        >
          {item.label}
        </Text>
        <Text style={styles.permName}>{item.page_name}</Text>
      </View>

      {/* Sort Order input — only for non-settings */}
      {!isSettings && (
        <TextInput
          style={[
            styles.sortInput,
            item.is_enabled && styles.sortInputEnabled,
          ]}
          value={String(item.sort_order)}
          keyboardType="numeric"
          maxLength={2}
          onChangeText={(t) => {
            const n = parseInt(t, 10);
            if (!isNaN(n) && n >= 1) onSortChange(item.page_name, n);
          }}
        />
      )}

      {/* Toggle */}
      <Switch
        value={isSettings ? true : item.is_enabled}
        disabled={isSettings}
        onValueChange={(v) => onChange(item.page_name, v)}
        trackColor={{ false: '#ddd', true: BPCL_BLUE + '66' }}
        thumbColor={item.is_enabled || isSettings ? BPCL_BLUE : '#bbb'}
      />
    </View>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function StaffAccessScreen() {
  const { currentUser } = useDataStore();

  // Guard — only admin
  if (currentUser?.username !== ADMIN_USERNAME) {
    return (
      <View style={styles.denied}>
        <Ionicons name="lock-closed" size={64} color="#ccc" />
        <Text style={styles.deniedText}>Access Restricted</Text>
        <Text style={styles.deniedSub}>
          Only Jitesh can manage staff permissions.
        </Text>
      </View>
    );
  }

  return <StaffAccessContent />;
}

function StaffAccessContent() {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [selectedUser, setSelectedUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [loadingPerms, setLoadingPerms] = useState(false);
  const [saving, setSaving] = useState(false);
  const [userSearch, setUserSearch] = useState('');

  // ── Load users ──────────────────────────────────────────────────
  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const { data, error } = await supabase
        .from('auth_user')
        .select('id, username, first_name, last_name, is_active')
        .eq('is_active', true)
        .order('username');

      if (error) throw error;

      // Exclude admin from the list
      const filtered = (data || []).filter(
        (u: AuthUser) => u.username !== 'Jitesh'
      );
      setUsers(filtered);
    } catch (err: any) {
      Alert.alert('Error', 'Failed to load users: ' + err.message);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  // ── Select user → load permissions ─────────────────────────────
  const selectUser = useCallback(async (user: AuthUser) => {
    setSelectedUser(user);
    setLoadingPerms(true);
    try {
      const saved = await fetchUserPermissions(user.id);
      const merged = mergeWithDefaults(saved, user.id);
      setPermissions(merged);
    } catch (err: any) {
      Alert.alert('Error', 'Failed to load permissions: ' + err.message);
    } finally {
      setLoadingPerms(false);
    }
  }, []);

  // ── Toggle permission ───────────────────────────────────────────
  const togglePermission = useCallback(
    (pageName: string, value: boolean) => {
      setPermissions((prev) =>
        prev.map((p) =>
          p.page_name === pageName ? { ...p, is_enabled: value } : p
        )
      );
    },
    []
  );

  // ── Change sort order ───────────────────────────────────────────
  const changeSortOrder = useCallback(
    (pageName: string, value: number) => {
      setPermissions((prev) =>
        prev.map((p) =>
          p.page_name === pageName ? { ...p, sort_order: value } : p
        )
      );
    },
    []
  );

  // ── Save ────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!selectedUser) return;
    setSaving(true);
    try {
      const toSave = permissions.map((p) => ({
        user_id: selectedUser.id,
        page_name: p.page_name,
        is_enabled:
          p.page_name === 'settings' ? true : p.is_enabled,
        sort_order: p.sort_order,
      }));

      await saveUserPermissions(selectedUser.id, toSave);
      Alert.alert(
        '✅ Saved',
        `Permissions updated for ${selectedUser.username}`
      );
    } catch (err: any) {
      Alert.alert('❌ Error', 'Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  }, [selectedUser, permissions]);

  // ── Enable / Disable ALL ────────────────────────────────────────
  const toggleAll = useCallback(
    (enable: boolean) => {
      setPermissions((prev) =>
        prev.map((p) => ({
          ...p,
          is_enabled: p.page_name === 'settings' ? true : enable,
        }))
      );
    },
    []
  );

  // ── Derive sections ─────────────────────────────────────────────
  const enriched = permissions.map((p) => {
    const meta = ALL_PAGES.find((a) => a.name === p.page_name)!;
    return { ...p, ...meta };
  });

  // sort_order 1–4 = main tabs, 5+ = more, settings = always last
  const mainTabs = enriched
    .filter((p) => p.page_name !== 'settings' && p.sort_order <= 4)
    .sort((a, b) => a.sort_order - b.sort_order);

  const moreTabs = enriched
    .filter((p) => p.page_name !== 'settings' && p.sort_order > 4)
    .sort((a, b) => a.sort_order - b.sort_order);

  const settingsPage = enriched.find((p) => p.page_name === 'settings');

  const enabledCount = permissions.filter(
    (p) => p.is_enabled
  ).length;

  // ── Filtered users ──────────────────────────────────────────────
  const filteredUsers = users.filter((u) =>
    `${u.username} ${u.first_name} ${u.last_name}`
      .toLowerCase()
      .includes(userSearch.toLowerCase())
  );

  // ── Render ──────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <Ionicons name="shield-checkmark" size={28} color={BPCL_BLUE} />
        <Text style={styles.headerTitle}>Staff Access Manager</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={loadingUsers}
            onRefresh={loadUsers}
            tintColor={BPCL_BLUE}
          />
        }
        keyboardShouldPersistTaps="handled"
      >
        {/* ── User Picker ── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            <Ionicons name="people" size={16} color={BPCL_BLUE} />{' '}
            Select Staff Member
          </Text>

          <TextInput
            style={styles.searchInput}
            placeholder="Search users..."
            placeholderTextColor="#aaa"
            value={userSearch}
            onChangeText={setUserSearch}
          />

          {loadingUsers ? (
            <ActivityIndicator
              color={BPCL_BLUE}
              style={{ marginTop: 12 }}
            />
          ) : (
            <View style={styles.userList}>
              {filteredUsers.map((user) => (
                <TouchableOpacity
                  key={user.id}
                  style={[
                    styles.userChip,
                    selectedUser?.id === user.id &&
                      styles.userChipSelected,
                  ]}
                  onPress={() => selectUser(user)}
                  activeOpacity={0.75}
                >
                  <View style={styles.userChipAvatar}>
                    <Text style={styles.userChipAvatarText}>
                      {user.username[0].toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.userChipInfo}>
                    <Text
                      style={[
                        styles.userChipName,
                        selectedUser?.id === user.id &&
                          styles.userChipNameSelected,
                      ]}
                    >
                      {user.username}
                    </Text>
                    {(user.first_name || user.last_name) && (
                      <Text style={styles.userChipFull}>
                        {`${user.first_name} ${user.last_name}`.trim()}
                      </Text>
                    )}
                  </View>
                  {selectedUser?.id === user.id && (
                    <Ionicons
                      name="checkmark-circle"
                      size={20}
                      color={BPCL_BLUE}
                    />
                  )}
                </TouchableOpacity>
              ))}

              {filteredUsers.length === 0 && (
                <Text style={styles.emptyText}>No users found</Text>
              )}
            </View>
          )}
        </View>

        {/* ── Permissions Panel ── */}
        {selectedUser && (
          <>
            {loadingPerms ? (
              <View style={styles.card}>
                <ActivityIndicator color={BPCL_BLUE} />
                <Text style={styles.loadingText}>
                  Loading permissions…
                </Text>
              </View>
            ) : (
              <>
                {/* ── Stats Bar ── */}
                <View style={styles.statsBar}>
                  <View style={styles.statItem}>
                    <Text style={styles.statNum}>{enabledCount}</Text>
                    <Text style={styles.statLabel}>Enabled</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statNum}>
                      {permissions.length - enabledCount}
                    </Text>
                    <Text style={styles.statLabel}>Disabled</Text>
                  </View>
                  <View style={styles.statDivider} />
                  <View style={styles.statItem}>
                    <Text style={styles.statNum}>
                      {permissions.length}
                    </Text>
                    <Text style={styles.statLabel}>Total</Text>
                  </View>
                </View>

                {/* ── Quick Actions ── */}
                <View style={styles.quickActions}>
                  <TouchableOpacity
                    style={[styles.quickBtn, styles.quickBtnEnable]}
                    onPress={() => toggleAll(true)}
                  >
                    <Ionicons
                      name="checkmark-done"
                      size={16}
                      color="#fff"
                    />
                    <Text style={styles.quickBtnText}>Enable All</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.quickBtn, styles.quickBtnDisable]}
                    onPress={() => toggleAll(false)}
                  >
                    <Ionicons name="close" size={16} color="#fff" />
                    <Text style={styles.quickBtnText}>Disable All</Text>
                  </TouchableOpacity>
                </View>

                {/* ── Sort Order Info ── */}
                <View style={styles.infoBox}>
                  <Ionicons
                    name="information-circle"
                    size={16}
                    color={BPCL_BLUE}
                  />
                  <Text style={styles.infoText}>
                    Sort order 1–4 = Main Tabs · 5+ = More Section ·
                    Settings is always last
                  </Text>
                </View>

                {/* ── Main Tabs Section ── */}
                <View style={styles.card}>
                  <SectionHeader
                    title="📱 Main Tabs (sort 1–4)"
                    count={mainTabs.filter((p) => p.is_enabled).length}
                  />
                  {mainTabs.map((item) => (
                    <PermRow
                      key={item.page_name}
                      item={item}
                      isSettings={false}
                      onChange={togglePermission}
                      onSortChange={changeSortOrder}
                    />
                  ))}
                </View>

                {/* ── More Section ── */}
                <View style={styles.card}>
                  <SectionHeader
                    title="⋯ More Section (sort 5+)"
                    count={moreTabs.filter((p) => p.is_enabled).length}
                  />
                  {moreTabs.map((item) => (
                    <PermRow
                      key={item.page_name}
                      item={item}
                      isSettings={false}
                      onChange={togglePermission}
                      onSortChange={changeSortOrder}
                    />
                  ))}
                </View>

                {/* ── Settings (always last) ── */}
                {settingsPage && (
                  <View style={styles.card}>
                    <SectionHeader
                      title="⚙️ Always Visible"
                      count={1}
                    />
                    <PermRow
                      item={settingsPage}
                      isSettings
                      onChange={togglePermission}
                      onSortChange={changeSortOrder}
                    />
                  </View>
                )}

                {/* ── Save Button ── */}
                <TouchableOpacity
                  style={[
                    styles.saveButton,
                    saving && styles.saveButtonDisabled,
                  ]}
                  onPress={handleSave}
                  disabled={saving}
                  activeOpacity={0.85}
                >
                  {saving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Ionicons
                        name="save"
                        size={20}
                        color="#fff"
                      />
                      <Text style={styles.saveButtonText}>
                        Save Permissions for {selectedUser.username}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>

                <View style={{ height: 40 }} />
              </>
            )}
          </>
        )}

        {/* ── Empty state ── */}
        {!selectedUser && !loadingUsers && (
          <View style={styles.emptyState}>
            <Ionicons
              name="person-add-outline"
              size={64}
              color="#ddd"
            />
            <Text style={styles.emptyStateText}>
              Select a staff member above to manage their page access
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#f4f6f9' },
  scroll:             { flex: 1 },
  scrollContent:      { padding: 16, paddingBottom: 60 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 20,
    paddingTop: Platform.OS === 'ios' ? 56 : 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#222' },

  // Card
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#222',
    marginBottom: 12,
  },

  // Search
  searchInput: {
    backgroundColor: '#f4f6f9',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 14,
    color: '#333',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#eee',
  },

  // User List
  userList:       { gap: 8 },
  userChip: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#f8f9fa',
    borderWidth: 1.5,
    borderColor: '#eee',
    gap: 12,
  },
  userChipSelected: {
    backgroundColor: BPCL_BLUE + '11',
    borderColor: BPCL_BLUE,
  },
  userChipAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: BPCL_BLUE + '22',
    justifyContent: 'center',
    alignItems: 'center',
  },
  userChipAvatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: BPCL_BLUE,
  },
  userChipInfo:         { flex: 1 },
  userChipName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#444',
  },
  userChipNameSelected: { color: BPCL_BLUE },
  userChipFull: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  emptyText: {
    textAlign: 'center',
    color: '#aaa',
    padding: 16,
  },

  // Stats
  statsBar: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    justifyContent: 'space-around',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },
  statItem:     { alignItems: 'center' },
  statNum: {
    fontSize: 24,
    fontWeight: '800',
    color: BPCL_BLUE,
  },
  statLabel:    { fontSize: 11, color: '#888', marginTop: 2 },
  statDivider: {
    width: 1,
    backgroundColor: '#eee',
  },

  // Quick Actions
  quickActions: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  quickBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 12,
    borderRadius: 12,
  },
  quickBtnEnable:   { backgroundColor: '#27ae60' },
  quickBtnDisable:  { backgroundColor: '#e74c3c' },
  quickBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },

  // Info box
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: BPCL_BLUE + '11',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  infoText: { flex: 1, fontSize: 12, color: '#555', lineHeight: 17 },

  // Section
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
    flex: 1,
  },
  sectionBadge: {
    backgroundColor: BPCL_BLUE,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  sectionBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },

  // Perm Row
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 12,
    backgroundColor: '#f8f9fa',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#eee',
  },
  permRowEnabled: {
    backgroundColor: '#f0f8ff',
    borderColor: BPCL_BLUE + '44',
  },
  permRowSettings: {
    backgroundColor: '#f0f0f0',
    borderColor: '#ddd',
  },
  permIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  permInfo:     { flex: 1 },
  permLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888',
  },
  permName: {
    fontSize: 11,
    color: '#bbb',
    marginTop: 2,
  },
  sortInput: {
    width: 40,
    height: 36,
    backgroundColor: '#eee',
    borderRadius: 8,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: '#555',
    borderWidth: 1,
    borderColor: '#ddd',
  },
  sortInputEnabled: {
    backgroundColor: BPCL_BLUE + '11',
    borderColor: BPCL_BLUE,
    color: BPCL_BLUE,
  },

  // Save
  saveButton: {
    backgroundColor: BPCL_BLUE,
    borderRadius: 16,
    padding: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginTop: 8,
    shadowColor: BPCL_BLUE,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  saveButtonDisabled: { opacity: 0.6 },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // Empty State
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    gap: 16,
  },
  emptyStateText: {
    color: '#bbb',
    fontSize: 15,
    textAlign: 'center',
    maxWidth: 260,
    lineHeight: 22,
  },

  // Loading
  loadingText: {
    textAlign: 'center',
    color: '#aaa',
    marginTop: 8,
    fontSize: 13,
  },

  // Access Denied
  denied: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#f4f6f9',
  },
  deniedText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#555',
  },
  deniedSub: {
    fontSize: 14,
    color: '#aaa',
    textAlign: 'center',
  },
});