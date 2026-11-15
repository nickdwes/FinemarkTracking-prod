import React, { useEffect } from 'react';
import { StyleSheet, Pressable } from 'react-native';
import Animated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { create } from 'zustand';
import { colors, radius, spacing, font } from '@/theme';

type ToastType = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}
interface ToastState {
  items: ToastItem[];
  show: (message: string, type?: ToastType) => void;
  dismiss: (id: number) => void;
}

let seq = 1;
export const useToastStore = create<ToastState>((set) => ({
  items: [],
  show: (message, type = 'info') => {
    const id = seq++;
    set((s) => ({ items: [...s.items, { id, message, type }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), 3500);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

/** Convenience singleton, usable outside React (e.g. in mutation callbacks). */
export const toast = {
  success: (m: string) => useToastStore.getState().show(m, 'success'),
  error: (m: string) => useToastStore.getState().show(m, 'error'),
  info: (m: string) => useToastStore.getState().show(m, 'info'),
};

const ICON: Record<ToastType, keyof typeof Ionicons.glyphMap> = {
  success: 'checkmark-circle',
  error: 'alert-circle',
  info: 'information-circle',
};
const CLR: Record<ToastType, string> = { success: colors.green, error: colors.red, info: colors.cyan };

export function ToastHost() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);
  return (
    <SafeAreaView style={styles.host} pointerEvents="box-none" edges={['top']}>
      {items.map((it) => (
        <Row key={it.id} item={it} onDismiss={() => dismiss(it.id)} />
      ))}
    </SafeAreaView>
  );
}

function Row({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  useEffect(() => {}, []);
  return (
    <Animated.View entering={FadeInDown} exiting={FadeOutUp} style={styles.toast}>
      <Pressable style={styles.pressable} onPress={onDismiss}>
        <Ionicons name={ICON[item.type]} size={20} color={CLR[item.type]} />
        <Animated.Text style={styles.text} numberOfLines={3}>
          {item.message}
        </Animated.Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center', zIndex: 1000, paddingHorizontal: spacing.lg },
  toast: {
    marginTop: spacing.sm,
    maxWidth: 480,
    width: '100%',
    backgroundColor: colors.bgSheet,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    shadowColor: colors.black,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  pressable: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, gap: spacing.sm },
  text: { color: colors.text, fontSize: font.size.sm, flex: 1 },
});
