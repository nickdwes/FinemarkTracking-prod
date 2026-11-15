import React from 'react';
import { Tabs } from 'expo-router';
import { BlurView } from 'expo-blur';
import { StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '@/features/auth/authStore';
import { tabsForRole, type TabKey } from '@/constants/roles';
import { colors } from '@/theme';

const TAB_META: Record<TabKey, { title: string; icon: keyof typeof Ionicons.glyphMap }> = {
  home: { title: 'Home', icon: 'grid-outline' },
  jobs: { title: 'Jobs', icon: 'construct-outline' },
  custody: { title: 'Custody', icon: 'cube-outline' },
  leads: { title: 'Leads', icon: 'people-outline' },
  customers: { title: 'Customers', icon: 'person-outline' },
  quotations: { title: 'Quotes', icon: 'document-text-outline' },
  team: { title: 'Team', icon: 'people-circle-outline' },
  invoices: { title: 'Invoices', icon: 'receipt-outline' },
  approvals: { title: 'Approvals', icon: 'shield-checkmark-outline' },
  reports: { title: 'Reports', icon: 'bar-chart-outline' },
  me: { title: 'Me', icon: 'person-circle-outline' },
};

// Every tab route file that exists in this group.
const ALL_TABS: TabKey[] = ['home', 'jobs', 'custody', 'leads', 'customers', 'quotations', 'team', 'invoices', 'approvals', 'reports', 'me'];

// Tabs backed by a folder/stack (index + [id] + new). Tapping these should always land
// on the list, never stay stuck on a create/detail screen the stack was left on.
const FOLDER_TABS = new Set<TabKey>(['jobs', 'leads', 'customers', 'quotations']);

// Route name for each tab (folders vs files).
const ROUTE_NAME: Record<TabKey, string> = {
  home: 'index',
  jobs: 'jobs',
  custody: 'custody',
  leads: 'leads',
  customers: 'customers',
  quotations: 'quotations',
  team: 'team',
  invoices: 'invoices',
  approvals: 'approvals',
  reports: 'reports',
  me: 'me',
};

export default function AppTabsLayout() {
  const user = useAuth((s) => s.user);
  const allowed = new Set(tabsForRole(user));

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.cyan,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.label,
        tabBarBackground: () => <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      {ALL_TABS.map((key) => (
        <Tabs.Screen
          key={key}
          name={ROUTE_NAME[key]}
          options={{
            title: TAB_META[key].title,
            href: allowed.has(key) ? undefined : null,
            tabBarIcon: ({ color, size }) => <Ionicons name={TAB_META[key].icon} size={size} color={color} />,
          }}
          listeners={
            FOLDER_TABS.has(key)
              ? ({ navigation }: any) => ({
                  tabPress: (e: any) => {
                    e.preventDefault();
                    navigation.navigate(ROUTE_NAME[key], { screen: 'index' });
                  },
                })
              : undefined
          }
        />
      ))}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    backgroundColor: 'rgba(8,12,22,0.6)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassBorder,
    elevation: 0,
  },
  label: { fontSize: 11, fontWeight: '600' },
});
