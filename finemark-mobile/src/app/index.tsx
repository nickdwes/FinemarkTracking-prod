import React from 'react';
import { View } from 'react-native';
import { Loading } from '@/components/ui';
import { colors } from '@/theme';

/** Placeholder entry — the root navigator redirects to (auth) or (app) once auth resolves. */
export default function Index() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Loading />
    </View>
  );
}
