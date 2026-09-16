import React, { useRef, useMemo, useCallback, useEffect } from 'react';
// Added `usePathname` here
import { Tabs, useRouter, usePathname } from 'expo-router';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import BottomSheet, { BottomSheetView } from '@gorhom/bottom-sheet';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import LoginScreen from './loginScreen';
import { useDataStore } from '@/store/dataStore';
import {
  useCurrentUserPermissions,
  ALL_PAGES,
  ADMIN_ONLY_PAGES,
  ALL_PAGES_INCLUDING_ADMIN,
} from '@/hooks/usePermissions';
import * as NavigationBar from 'expo-navigation-bar';
import { Buffer } from 'buffer';

// Import Supabase
import { supabase } from '@/lib/supabase';

// Import the push notification utility function
import { registerForPushNotificationsAsync } from '@/utils/notifications';

const BPCL_BLUE = '#017DC5';
global.Buffer = Buffer;

// ── More Bottom Sheet ─────────────────────────────────────────────────────────

function MoreBottomSheet({
  bottomSheetRef,
  moreItems,
}: {
  bottomSheetRef: React.RefObject<any>;
  moreItems: typeof ALL_PAGES;
}) {
  const router = useRouter();
  const snapPoints = useMemo(() => ['50%'], []);

  const handleNavigate = useCallback(
    (name: string) => {
      bottomSheetRef.current?.close();
      setTimeout(() => {
        router.push(`/(tabs)/${name}` as any);
      }, 200);
    },
    [router, bottomSheetRef]
  );

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      backgroundStyle={styles.bottomSheetBg}
      handleIndicatorStyle={styles.bottomSheetHandle}
    >
      <BottomSheetView style={styles.bottomSheetContent}>
        <Text style={styles.bottomSheetTitle}>More Options</Text>
        <View style={styles.moreGrid}>
          {moreItems.map((item) => (
            <TouchableOpacity
              key={item.name}
              style={styles.moreItem}
              activeOpacity={0.7}
              onPress={() => handleNavigate(item.name)}
            >
              <View
                style={[
                  styles.moreItemIcon,
                  { backgroundColor: item.color + '22' },
                ]}
              >
                <Ionicons name={item.icon} size={15} color={item.color} />
              </View>
              <Text style={styles.moreItemLabel} numberOfLines={2}>
                {item.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

// ── Authenticated Layout ──────────────────────────────────────────────────────

function AuthenticatedLayout() {
  const bottomSheetRef = useRef<any>(null);
  const { pagePermissions, currentUser } = useDataStore();
  const router = useRouter();
  const pathname = usePathname(); // Get the current URL path

  // ✅ Always called — hooks never conditionally skipped
  const { loading: loadingPerms } = useCurrentUserPermissions();

  // Determine the first allowed screen name safely (executed before early return)
  const firstAllowedTabName = useMemo(() => {
    if (loadingPerms || !pagePermissions) return null;

    const isAdmin = currentUser?.username?.toLowerCase() === 'jitesh';
    const adminOnlyNames = new Set(ADMIN_ONLY_PAGES.map((p) => p.name));

    // Sort permissions
    const sorted = [...pagePermissions].sort(
      (a, b) => a.sort_order - b.sort_order
    );

    // Filter non-settings and non-admin pages
    const enabled = sorted.filter(
      (p) =>
        p.is_enabled &&
        p.page_name !== 'settings' &&
        !adminOnlyNames.has(p.page_name)
    );

    // Return the first enabled tab
    if (enabled.length > 0) {
      return enabled[0].page_name;
    }

    // Fallbacks if no basic tabs are enabled
    if (isAdmin) return 'staff';
    return 'settings';
  }, [pagePermissions, loadingPerms, currentUser]);

  // Redirect to the first allowed tab if the user lands on the root "/" route
  useEffect(() => {
    if (!loadingPerms && firstAllowedTabName) {
      if (pathname === '/' && firstAllowedTabName !== 'index') {
        // use replace to avoid adding "/" to the back-navigation stack
        router.replace(`/(tabs)/${firstAllowedTabName}` as any);
      }
    }
  }, [loadingPerms, pathname, firstAllowedTabName, router]);

  const openMore = useCallback(() => {
    bottomSheetRef.current?.snapToIndex(0);
  }, []);

  // ── Show loader while permissions are being fetched ───────────────
  if (loadingPerms) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={BPCL_BLUE} />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  // ── Admin check ───────────────────────────────────────────────────
  const isAdmin = currentUser?.username?.toLowerCase() === 'jitesh';

  // ── Enrich helper — looks up icon/color/label from page name ─────
  const enrich = (pageName: string) =>
    ALL_PAGES_INCLUDING_ADMIN.find((p) => p.name === pageName);

  // ── Sort all permissions by sort_order ────────────────────────────
  const sortedPerms = [...pagePermissions].sort(
    (a, b) => a.sort_order - b.sort_order
  );

  // Admin-only page names (e.g. 'staff')
  const adminOnlyNames = new Set(ADMIN_ONLY_PAGES.map((p) => p.name));

  // Enabled pages excluding 'settings' and admin-only pages
  // (admin-only handled separately below)
  const enabledNonSettings = sortedPerms.filter(
    (p) =>
      p.is_enabled &&
      p.page_name !== 'settings' &&
      !adminOnlyNames.has(p.page_name)
  );

  // First 4 enabled → main tab bar
  const mainTabPerms = enabledNonSettings.slice(0, 4);
  // Rest → More bottom sheet
  const moreTabPerms = enabledNonSettings.slice(4);

  const mainTabsMeta = mainTabPerms
    .map((p) => enrich(p.page_name))
    .filter(Boolean) as typeof ALL_PAGES;

  const moreTabsMeta = moreTabPerms
    .map((p) => enrich(p.page_name))
    .filter(Boolean) as typeof ALL_PAGES;

  console.log('👤 currentUser:', currentUser?.username, '| isAdmin:', isAdmin);
  console.log('📋 sortedPerms:', sortedPerms.map(p => `${p.page_name}(${p.sort_order})`));
  console.log('✅ mainTabsMeta:', mainTabsMeta.map(t => t.name));
  console.log('📦 moreTabsMeta:', moreTabsMeta.map(t => t.name));

  const showMore = moreTabsMeta.length > 0;

  // Pages that are NOT in main tabs → register as hidden
  // so Expo Router doesn't complain about unregistered screens
  const mainTabNames = new Set(mainTabsMeta.map((t) => t.name));

  const hiddenPages = ALL_PAGES.filter(
    (p) =>
      p.name !== 'settings' &&
      !mainTabNames.has(p.name)
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: BPCL_BLUE,
          tabBarInactiveTintColor: '#888',
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          tabBarStyle: {
            height: 62 + (Platform.OS === 'android' ? 8 : 0),
            paddingBottom: Platform.OS === 'android' ? 12 : 8,
            paddingTop: 8,
            backgroundColor: '#fff',
            borderTopWidth: 1,
            borderTopColor: '#eee',
            marginBottom: Platform.OS === 'android' ? 28 : 0,
          },
        }}
      >
        {/* ── Dynamic Main Tabs (first 4 enabled) ── */}
        {mainTabsMeta.map((tab) => (
          <Tabs.Screen
            key={tab.name}
            name={tab.name}
            options={{
              title: tab.label,
              tabBarIcon: ({ color, size }) => (
                <Ionicons name={tab.icon} size={size} color={color} />
              ),
            }}
          />
        ))}

        {/* ── More Button (shown only when extra pages exist) ── */}
        {showMore ? (
          <Tabs.Screen
            name="more_placeholder"
            options={{
              title: 'More',
              tabBarButton: () => (
                <Pressable
                  onPress={openMore}
                  style={styles.moreTabButton}
                >
                  {({ pressed }) => (
                    <>
                      <Ionicons
                        name="grid"
                        size={24}
                        color={pressed ? BPCL_BLUE : '#888'}
                      />
                      <Text
                        style={[
                          styles.moreTabLabel,
                          pressed && { color: BPCL_BLUE },
                        ]}
                      >
                        More
                      </Text>
                    </>
                  )}
                </Pressable>
              ),
            }}
          />
        ) : (
          <Tabs.Screen
            name="more_placeholder"
            options={{ href: null }}
          />
        )}

        {/* ── Settings — always visible, always last ── */}
        <Tabs.Screen
          name="settings"
          options={{
            title: 'Settings',
            tabBarLabel: () => null,        // ← hides label
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings" size={size + 4} color={color} /> // ← slightly bigger icon since no label
            ),
          }}
        />

        {/* ── Staff Tab — visible ONLY for Jitesh ── */}
        {isAdmin ? (
          <Tabs.Screen
            name="staff"
            options={{
              title: 'Staff',
              tabBarIcon: ({ color, size }) => (
                <Ionicons
                  name="shield-checkmark"
                  size={size}
                  color={color}
                />
              ),
            }}
          />
        ) : (
          <Tabs.Screen name="staff" options={{ href: null }} />
        )}

        {/* ── loginScreen — always hidden ── */}
        <Tabs.Screen name="loginScreen" options={{ href: null }} />

        {/* ── All other non-main pages registered as hidden ── */}
        {hiddenPages.map((page) => (
          <Tabs.Screen
            key={`hidden-${page.name}`}
            name={page.name}
            options={{ href: null }}
          />
        ))}
      </Tabs>

      {/* ── More Bottom Sheet ── */}
      {showMore && (
        <MoreBottomSheet
          bottomSheetRef={bottomSheetRef}
          moreItems={moreTabsMeta}
        />
      )}
    </GestureHandlerRootView>
  );
}

// ── Root Layout ───────────────────────────────────────────────────────────────

export default function TabLayout() {
  const { currentUser, setCurrentUser } = useDataStore();

  // Set native navigation bar parameters and register push notifications on mount
  useEffect(() => {
    // 1. Android Navigation Bar Setup
    if (Platform.OS === 'android') {
      const setupNavBar = async () => {
        await NavigationBar.setPositionAsync('relative');
        await NavigationBar.setBackgroundColorAsync('#ffffff');
        await NavigationBar.setButtonStyleAsync('dark');
      };
      setupNavBar();
    }

    // 2. Request Permissions, Fetch Expo Push Token, and save to Supabase database
    const setupNotifications = async () => {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        console.log("Successfully retrieved Push Token:", token);
        try {
          // Store token in Supabase
          const { error } = await supabase
            .from('device_tokens')
            .upsert({ token: token }, { onConflict: 'token' });
          if (error) {
            console.error("Error saving token to Supabase:", error.message);
          } else {
            console.log("Device token registered in Supabase successfully.");
          }
        } catch (dbErr) {
          console.error("Failed to write device token to Supabase:", dbErr);
        }
      }
    };
    setupNotifications();
  }, []);

  // Not logged in → show login screen
  if (!currentUser) {
    return <LoginScreen onLoginSuccess={(u: any) => setCurrentUser(u)} />;
  }

  // ✅ Separate component so hooks always run in same order
  return <AuthenticatedLayout />;
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: '#aaa',
    fontWeight: '500',
  },
  moreTabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: 8,
    gap: 3,
  },
  moreTabLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#888',
    marginTop: 2,
  },
  bottomSheetBg: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 12,
  },
  bottomSheetHandle: {
    backgroundColor: '#ccc',
    width: 40,
    height: 4,
  },
  bottomSheetContent: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 24,
  },
  bottomSheetTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 24,
    textAlign: 'center',
    letterSpacing: 0.3,
  },
  moreGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'flex-start',
  },
  moreItem: {
    width: '31.3%',
    backgroundColor: '#f8f9fa',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#efefef',
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    marginBottom: 4,
  },
  moreItemIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
  },
  moreItemLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
  },
});