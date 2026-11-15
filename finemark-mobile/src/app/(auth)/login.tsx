import React, { useState } from 'react';
import { View, StyleSheet, KeyboardAvoidingView, Platform, Pressable } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Screen, Field, NeonButton, Txt, toast } from '@/components/ui';
import { useAuth } from '@/features/auth/authStore';
import { getBiometricCapability } from '@/features/auth/biometrics';
import { colors, neonGradient, radius, spacing } from '@/theme';
import type { ApiError } from '@/lib/api';

const NOTICE_TEXT: Record<string, string> = {
  session_expired: 'Your session expired. Please sign in again.',
  idle_timeout: 'Signed out after inactivity. Please sign in again.',
  disabled: 'This account has been disabled. Contact an administrator.',
};

export default function LoginScreen() {
  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInPassword = useAuth((s) => s.signInPassword);
  const sendOtp = useAuth((s) => s.sendOtp);
  const signInOtp = useAuth((s) => s.signInOtp);
  const enableBiometric = useAuth((s) => s.enableBiometric);
  const notice = useAuth((s) => s.notice);
  const clearNotice = useAuth((s) => s.clearNotice);

  const offerBiometric = async () => {
    const cap = await getBiometricCapability();
    if (cap.available && cap.enrolled) {
      // Enable silently-friendly: prompts once to confirm.
      await enableBiometric(true).catch(() => {});
    }
  };

  const doPassword = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    clearNotice();
    try {
      await signInPassword(email, password);
      await offerBiometric();
    } catch (e) {
      const err = e as ApiError;
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const doSendOtp = async () => {
    if (!email.trim()) {
      setError('Enter your email first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendOtp(email);
      setOtpSent(true);
      toast.success('Code sent to your email');
    } catch (e) {
      setError(mapError(e as ApiError));
    } finally {
      setBusy(false);
    }
  };

  const doVerifyOtp = async () => {
    if (!code.trim()) {
      setError('Enter the 6-digit code.');
      return;
    }
    setBusy(true);
    setError(null);
    clearNotice();
    try {
      await signInOtp(email, code);
      await offerBiometric();
    } catch (e) {
      setError(mapError(e as ApiError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll padded>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.brandWrap}>
          <LinearGradient colors={neonGradient} style={styles.logo} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
            <Ionicons name="hardware-chip-outline" size={34} color={colors.white} />
          </LinearGradient>
          <Txt variant="display" center style={{ marginTop: spacing.lg }}>
            Finemark
          </Txt>
          <Txt variant="muted" center>
            Field & Sales Operations
          </Txt>
        </View>

        {notice && NOTICE_TEXT[notice] ? (
          <Animated.View entering={FadeIn} style={styles.notice}>
            <Ionicons name="information-circle" size={18} color={colors.amber} />
            <Txt variant="muted" style={{ color: colors.amber, flex: 1, marginLeft: spacing.sm }}>
              {NOTICE_TEXT[notice]}
            </Txt>
          </Animated.View>
        ) : null}

        <View style={styles.form}>
          <Field
            label="Email"
            placeholder="you@finemarktracking.co.ke"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            value={email}
            onChangeText={setEmail}
            editable={!busy}
          />

          {mode === 'password' ? (
            <Field
              label="Password"
              placeholder="••••••••"
              secureTextEntry
              autoComplete="password"
              value={password}
              onChangeText={setPassword}
              editable={!busy}
              onSubmitEditing={doPassword}
              returnKeyType="go"
            />
          ) : otpSent ? (
            <Field
              label="6-digit code"
              placeholder="••••••"
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={setCode}
              editable={!busy}
              hint={`Sent to ${email}`}
            />
          ) : null}

          {error ? (
            <Txt variant="muted" style={{ color: colors.red, marginBottom: spacing.sm }}>
              {error}
            </Txt>
          ) : null}

          {mode === 'password' ? (
            <NeonButton label="Sign in" icon="log-in-outline" loading={busy} onPress={doPassword} />
          ) : otpSent ? (
            <NeonButton label="Verify & sign in" icon="checkmark-outline" loading={busy} onPress={doVerifyOtp} />
          ) : (
            <NeonButton label="Email me a code" icon="mail-outline" loading={busy} onPress={doSendOtp} />
          )}

          <Pressable
            style={styles.switchRow}
            onPress={() => {
              setError(null);
              setOtpSent(false);
              setMode((m) => (m === 'password' ? 'otp' : 'password'));
            }}
          >
            <Txt variant="muted" style={{ color: colors.cyan }}>
              {mode === 'password' ? 'Sign in with an email code instead' : 'Use password instead'}
            </Txt>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function mapError(err: ApiError): string {
  if (!err) return 'Something went wrong.';
  if (err.code === 'RATE_LIMITED' || err.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
  if (err.status === 401 || err.code === 'INVALID_CREDENTIALS') return 'Incorrect email or password.';
  if (err.code === 'NETWORK' || err.status === 0) return 'No connection. Check your network and retry.';
  return err.message || 'Sign in failed.';
}

const styles = StyleSheet.create({
  brandWrap: { alignItems: 'center', marginTop: spacing.xxxl, marginBottom: spacing.xl },
  logo: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.cyan,
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.amberDim,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  form: { marginTop: spacing.md },
  switchRow: { alignItems: 'center', paddingVertical: spacing.lg },
});
