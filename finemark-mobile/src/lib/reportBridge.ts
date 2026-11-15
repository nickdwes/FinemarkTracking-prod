import * as WebBrowser from 'expo-web-browser';
import { CONFIG } from '@/constants/config';
import { getRefreshToken } from '@/lib/session';
import { colors } from '@/theme';

/**
 * Open an existing web-portal report inside the in-app browser without a second login.
 *
 * Hands the (single-use over TLS) refresh token to a small static bridge page at
 * finemark-ui/mobile-bridge.html via the URL fragment (fragments are never sent to the
 * server). The bridge calls POST /api/auth/refresh — which both returns a fresh access
 * token and sets the fm_rt cookie in the in-app browser's cookie jar (satisfying nginx's
 * page gate) — writes the session into localStorage for app.js, then redirects to `to`.
 */
export async function openReport(page: string): Promise<void> {
  const rt = await getRefreshToken();
  const to = encodeURIComponent(page);
  const base = `${CONFIG.WEB_ORIGIN}/mobile-bridge.html?to=${to}`;
  const url = rt ? `${base}#rt=${encodeURIComponent(rt)}` : `${CONFIG.WEB_ORIGIN}/${page}`;
  await WebBrowser.openBrowserAsync(url, {
    toolbarColor: colors.bg,
    controlsColor: colors.cyan,
    dismissButtonStyle: 'close',
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
  });
}

export interface ReportLink {
  key: string;
  title: string;
  subtitle: string;
  page: string;
  icon: string;
  roles?: string[]; // if omitted, shown to all
}

export const REPORTS: ReportLink[] = [
  { key: 'tech', title: 'Technical Operations', subtitle: 'Pipeline, field team & job execution', page: 'technical.html', icon: 'construct-outline', roles: ['Admin', 'Technical', 'Technician', 'InstallOffice', 'Executive'] },
  { key: 'custody', title: 'Device Custody Report', subtitle: 'Devices & SIMs held by technicians', page: 'inventory-custody-report.html', icon: 'cube-outline', roles: ['Admin', 'Technical', 'InstallOffice', 'InventoryManager'] },
  { key: 'techdash', title: 'Technical Dashboard', subtitle: 'Installations & SLA overview', page: 'technical-dashboard.html', icon: 'speedometer-outline', roles: ['Admin', 'Technical', 'InstallOffice', 'Executive'] },
  { key: 'certdash', title: 'Certificates', subtitle: 'Certificate pipeline & inventory', page: 'certificate-dashboard.html', icon: 'ribbon-outline', roles: ['Admin', 'CertAdmin'] },
  { key: 'fininv', title: 'Invoice AR Dashboard', subtitle: 'Receivables & aging', page: 'finance-invoice-dashboard.html', icon: 'cash-outline', roles: ['Admin', 'Finance', 'Executive'] },
  { key: 'sales', title: 'Sales Intelligence', subtitle: 'Leads, conversion & pipeline', page: 'sales-intelligence.html', icon: 'trending-up-outline', roles: ['Admin', 'BDM', 'BDMCorporate', 'CorporateSales', 'Executive'] },
  { key: 'exec', title: 'Executive Dashboard', subtitle: 'Company-wide KPIs', page: 'executive-dashboard.html', icon: 'analytics-outline', roles: ['Admin', 'Executive'] },
];
