import { Stack } from 'expo-router';
import { colors } from '@/theme';

export default function TeamLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[repId]" />
    </Stack>
  );
}
