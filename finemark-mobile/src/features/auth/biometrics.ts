import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';

export interface BiometricCapability {
  available: boolean;
  enrolled: boolean;
  label: string; // "Face ID" | "Touch ID" | "Fingerprint" | "Biometrics"
}

export async function getBiometricCapability(): Promise<BiometricCapability> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    let label = 'Biometrics';
    if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
      label = Platform.OS === 'ios' ? 'Face ID' : 'Face Unlock';
    } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
      label = Platform.OS === 'ios' ? 'Touch ID' : 'Fingerprint';
    }
    return { available: hasHardware, enrolled, label };
  } catch {
    return { available: false, enrolled: false, label: 'Biometrics' };
  }
}

export async function promptBiometric(reason = 'Unlock Finemark'): Promise<boolean> {
  try {
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Use password',
      disableDeviceFallback: false,
    });
    return res.success;
  } catch {
    return false;
  }
}
