import React, { useState } from 'react';
import { View, StyleSheet, Pressable, ActivityIndicator, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';

import { Txt, toast } from '@/components/ui';
import { TechApi } from './api';
import { colors, radius, spacing } from '@/theme';

export interface Evidence {
  url: string;
  filename?: string;
  localUri?: string;
}

/**
 * Capture or pick photos and upload them to the ticket's evidence store
 * (POST /installation-tickets/:id/upload, multipart field `file`).
 */
export function EvidencePicker({
  ticketId,
  value,
  onChange,
  label = 'Evidence',
}: {
  ticketId: string;
  value: Evidence[];
  onChange: (next: Evidence[]) => void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);

  const handle = async (result: ImagePicker.ImagePickerResult) => {
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    setBusy(true);
    try {
      const name = asset.fileName || `photo_${Date.now()}.jpg`;
      const type = asset.mimeType || 'image/jpeg';
      const res = await TechApi.upload(ticketId, { uri: asset.uri, name, type });
      const uploaded = res?.data || res;
      onChange([...value, { url: uploaded.url, filename: uploaded.filename, localUri: asset.uri }]);
      toast.success('Photo attached');
    } catch (e: any) {
      toast.error(e?.message || 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const capture = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return toast.error('Camera permission needed');
    await handle(await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false }));
  };

  const pick = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return toast.error('Photos permission needed');
    await handle(await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ['images'] }));
  };

  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  return (
    <View style={{ marginBottom: spacing.md }}>
      <Txt variant="label" style={{ marginBottom: spacing.sm }}>
        {label}
      </Txt>
      <View style={styles.grid}>
        {value.map((ev, i) => (
          <View key={`${ev.url}-${i}`} style={styles.thumbWrap}>
            <Image source={{ uri: ev.localUri || ev.url }} style={styles.thumb} />
            <Pressable style={styles.remove} onPress={() => remove(i)} hitSlop={8}>
              <Ionicons name="close-circle" size={20} color={colors.red} />
            </Pressable>
          </View>
        ))}
        <Pressable style={styles.addBtn} onPress={capture} disabled={busy}>
          {busy ? <ActivityIndicator color={colors.cyan} /> : <Ionicons name="camera-outline" size={24} color={colors.cyan} />}
          <Txt variant="faint" style={{ marginTop: 2 }}>
            Camera
          </Txt>
        </Pressable>
        <Pressable style={styles.addBtn} onPress={pick} disabled={busy}>
          <Ionicons name="images-outline" size={24} color={colors.cyan} />
          <Txt variant="faint" style={{ marginTop: 2 }}>
            Gallery
          </Txt>
        </Pressable>
      </View>
    </View>
  );
}

const SIZE = 76;
const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  thumbWrap: { width: SIZE, height: SIZE },
  thumb: { width: SIZE, height: SIZE, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.glassBorder },
  remove: { position: 'absolute', top: -6, right: -6, backgroundColor: colors.bg, borderRadius: 10 },
  addBtn: {
    width: SIZE,
    height: SIZE,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.glassBorderNeon,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.cyanDim,
  },
});
