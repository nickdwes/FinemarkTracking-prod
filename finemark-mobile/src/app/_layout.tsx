import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { View } from 'react-native';

import { queryClient, asyncPersister } from '@/lib/queryClient';
import { initOnlineManager } from '@/lib/online';
import { useAuth } from '@/features/auth/authStore';
import { ToastHost, Loading } from '@/components/ui';
import { colors } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});
initOnlineManager();

function RootNavigator() {
  const status = useAuth((s) => s.status);
  const bootstrap = useAuth((s) => s.bootstrap);
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (status !== 'loading') SplashScreen.hideAsync().catch(() => {});
  }, [status]);

  useEffect(() => {
    if (status === 'loading') return;
    const seg = segments as string[];
    const group = seg[0]; // '(auth)' | '(app)' | undefined
    const inAuth = group === '(auth)';

    if (status === 'authenticated') {
      if (inAuth || group === undefined) router.replace('/(app)');
    } else if (status === 'locked') {
      if (seg[1] !== 'unlock') router.replace('/(auth)/unlock');
    } else {
      // unauthenticated
      if (seg[1] !== 'login') router.replace('/(auth)/login');
    }
  }, [status, segments, router]);

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading label="Starting Finemark…" />
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: asyncPersister }}>
          <RootNavigator />
          <ToastHost />
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
