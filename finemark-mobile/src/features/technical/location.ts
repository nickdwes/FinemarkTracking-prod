import * as Location from 'expo-location';

export interface GpsFix {
  gpsLat: number;
  gpsLng: number;
  gpsAccuracy: number;
}

export type GpsResult =
  | { ok: true; fix: GpsFix }
  | { ok: false; reason: 'unavailable' | 'denied' | 'disabled' | 'failed'; message: string };

const GPS_TIMEOUT_MS = 8000;

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Location timed out')), ms)),
  ]);
}

/**
 * Best-effort single GPS fix. NEVER throws — returns a discriminated result so
 * callers (check-in / travel / arrived) can proceed WITHOUT coordinates when the
 * device can't provide them. GPS is optional server-side; blocking on it would
 * strand technicians who are in a basement/parking garage, have denied the
 * permission, or are running a dev-client build that predates expo-location
 * (touching the native module then throws "Cannot find native module 'ExpoLocation'").
 */
export async function tryGetPosition(): Promise<GpsResult> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) {
      return { ok: false, reason: 'denied', message: 'Location permission denied' };
    }
    const enabled = await Location.hasServicesEnabledAsync().catch(() => true);
    if (!enabled) {
      return { ok: false, reason: 'disabled', message: 'Location services are off' };
    }
    const pos = await timeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      GPS_TIMEOUT_MS,
    );
    return {
      ok: true,
      fix: {
        gpsLat: pos.coords.latitude,
        gpsLng: pos.coords.longitude,
        gpsAccuracy: pos.coords.accuracy ?? 0,
      },
    };
  } catch (e: any) {
    const msg = String(e?.message || e || '');
    // Native module absent from this build → GPS capability simply isn't there yet.
    if (/native module|expolocation|not available|doesn'?t exist|cannot find|is not available/i.test(msg)) {
      return { ok: false, reason: 'unavailable', message: 'GPS not available in this build' };
    }
    return { ok: false, reason: 'failed', message: msg || 'Could not get location' };
  }
}

/** Strict helper — throws on failure. Prefer tryGetPosition for check-in flows. */
export async function getPosition(): Promise<GpsFix> {
  const r = await tryGetPosition();
  if (!r.ok) throw new Error(r.message);
  return r.fix;
}
