import { Stack } from 'expo-router';
import { colors } from '@/theme';

export default function CustomersLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="[id]" />
      <Stack.Screen name="new" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
