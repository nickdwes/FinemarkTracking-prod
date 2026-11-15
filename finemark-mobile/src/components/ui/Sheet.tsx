import React from 'react';
import { Modal, View, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, spacing } from '@/theme';
import { Txt } from './Text';

interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  scroll?: boolean;
}

/** Bottom sheet built on RN Modal (no extra native deps). Frosted panel. */
export function Sheet({ visible, onClose, title, children, scroll = true }: SheetProps) {
  const insets = useSafeAreaInsets();
  // Clear the Android nav bar / iOS home indicator so the bottom of the sheet
  // (close button, list, primary action) is never tucked under the system bar.
  const bottomPad = Math.max(insets.bottom, spacing.md) + spacing.md;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container} pointerEvents="box-none">
        <BlurView intensity={40} tint="dark" style={[styles.panel, { paddingBottom: bottomPad }]}>
          <View style={styles.handle} />
          {title ? (
            <View style={styles.header}>
              <Txt variant="heading">{title}</Txt>
              <Pressable onPress={onClose} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textMuted} />
              </Pressable>
            </View>
          ) : null}
          {scroll ? (
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
              {children}
            </ScrollView>
          ) : (
            <View style={styles.content}>{children}</View>
          )}
        </BlurView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  container: { flex: 1, justifyContent: 'flex-end' },
  panel: {
    maxHeight: '88%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.glassBorder,
    backgroundColor: colors.bgSheet,
    overflow: 'hidden',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.glassBorder, marginTop: spacing.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
});
