import { Request } from "express";
import { UAParser } from "ua-parser-js";
import geoip from "geoip-lite";

/**
 * Resolves the real client IP from an Express request. Requires
 * `app.set("trust proxy", true)` upstream so req.ip reflects the
 * X-Forwarded-For chain set by our own reverse proxies (Caddy -> nginx)
 * rather than their internal docker addresses.
 */
export const getClientIp = (req: Request): string | null => {
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || null;
  if (!raw) return null;
  // Normalize IPv4-mapped IPv6 form (::ffff:1.2.3.4) to plain IPv4
  return raw.startsWith("::ffff:") ? raw.slice(7) : raw;
};

export interface DeviceInfo {
  browser: string | null;
  os: string | null;
  deviceType: string | null;
}

export const parseUserAgent = (userAgent: string | undefined | null): DeviceInfo => {
  if (!userAgent) return { browser: null, os: null, deviceType: null };
  const { browser, os, device } = new UAParser(userAgent).getResult();
  const browserStr = browser.name ? `${browser.name}${browser.version ? " " + browser.version.split(".")[0] : ""}` : null;
  const osStr = os.name ? `${os.name}${os.version ? " " + os.version : ""}` : null;
  return {
    browser: browserStr,
    os: osStr,
    deviceType: device.type || "desktop",
  };
};

export interface GeoInfo {
  city: string | null;
  region: string | null;
  country: string | null;
}

const PRIVATE_IP_RANGES = [
  /^10\./, /^127\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^fc/, /^fd/,
];

export const geoLookup = (ip: string | null): GeoInfo => {
  const empty: GeoInfo = { city: null, region: null, country: null };
  if (!ip || PRIVATE_IP_RANGES.some((re) => re.test(ip))) return empty;
  try {
    const result = geoip.lookup(ip);
    if (!result) return empty;
    return {
      city: result.city || null,
      region: result.region || null,
      country: result.country || null,
    };
  } catch {
    return empty;
  }
};
