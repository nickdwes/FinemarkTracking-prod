import { Linking, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { CONFIG } from '@/constants/config';
import { getAccessToken } from '@/lib/session';
import { toast } from '@/components/ui';
import { SalesApi } from '@/features/sales/api';

/**
 * Download the real quotation PDF and hand it to the OS to open — Android's share
 * sheet lists actual PDF viewers (Files, Drive, Chrome, etc.) as targets, so this
 * is the "view it" path. There's no bundled in-app PDF renderer here: Expo Go
 * ships no native WebView/PDF module, and adding one (react-native-webview) needs
 * a custom dev-client rebuild — out of reach for a routine feature add. Unlike
 * shareQuotePdf, this never transitions the quote to Sent — opening it yourself
 * to check it isn't the same signal as sending it to the customer.
 */
export async function viewQuotePdf(id: string, quoteNo: string): Promise<void> {
  let Sharing: typeof import('expo-sharing');
  try {
    Sharing = await import('expo-sharing');
    if (!(await Sharing.isAvailableAsync())) return toast.error('Viewing needs the updated app build.');
  } catch {
    return toast.error('Viewing needs the updated app build.');
  }
  try {
    const token = getAccessToken();
    const safeName = String(quoteNo || id).replace(/[^A-Za-z0-9_-]/g, '_');
    const dest = `${FileSystem.cacheDirectory}${safeName}.pdf`;
    const res = await FileSystem.downloadAsync(
      `${CONFIG.API_BASE_URL}/crm/quotes/${id}/pdf`,
      dest,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (res.status && res.status >= 400) return toast.error('Could not load the quotation PDF');
    await Sharing.shareAsync(res.uri, {
      mimeType: 'application/pdf',
      dialogTitle: Platform.OS === 'android' ? `Open quotation ${quoteNo} with…` : `Quotation ${quoteNo}`,
      UTI: 'com.adobe.pdf',
    });
  } catch (e: any) {
    toast.error(e?.message || 'Could not open the quotation PDF');
  }
}

// Terminal/already-sent statuses — a share action on a quote already in one of
// these is a no-op for the sent-transition (mirrors web's ensureQuoteMarkedSent(),
// which only fires the transition when the quote is still Draft).
const NO_TRANSITION_STATUSES = ['Sent', 'Accepted', 'Rejected', 'Superseded'];

/**
 * Download the authenticated quotation PDF and open the OS share sheet (WhatsApp,
 * email-with-attachment, Drive, …). Uses expo-sharing, a native module: it is present
 * only in a dev/preview build that was built AFTER expo-sharing was added, so we lazy-
 * import it and, if it's unavailable (e.g. the older dev client), fall back to a
 * WhatsApp text message so the button still does something useful.
 */
export async function shareQuotePdf(
  id: string,
  quoteNo: string,
  fallback?: { phone?: string; text?: string },
  opts?: { currentStatus?: string | null; onMarkedSent?: () => void },
): Promise<void> {
  // Optimistic, best-effort — the OS share sheet doesn't reliably report "the customer
  // received it", so (matching web's optimistic mark-as-sent right after the share
  // action fires) we transition Draft → Sent as soon as a share genuinely went out,
  // without waiting for confirmed delivery. Never blocks/alerts on failure.
  const maybeMarkSent = () => {
    if (opts?.currentStatus && NO_TRANSITION_STATUSES.includes(opts.currentStatus)) return;
    SalesApi.markQuoteSent(id)
      .then(() => opts?.onMarkedSent?.())
      .catch((e) => console.warn('[shareQuotePdf] mark-as-sent failed:', (e as any)?.message));
  };

  const doFallback = (reason?: string) => {
    if (fallback?.text) {
      const phone = (fallback.phone || '').replace(/\D/g, '');
      const url = phone
        ? `https://wa.me/${phone}?text=${encodeURIComponent(fallback.text)}`
        : `https://wa.me/?text=${encodeURIComponent(fallback.text)}`;
      Linking.openURL(url).catch(() => {});
      toast.info('Attaching the PDF needs the updated app build — sent a WhatsApp message instead.');
      maybeMarkSent();
    } else {
      toast.error(reason || 'Could not share the PDF');
    }
  };

  // Lazy-load expo-sharing so a build without the native module doesn't crash on import.
  let Sharing: typeof import('expo-sharing');
  try {
    Sharing = await import('expo-sharing');
    const available = await Sharing.isAvailableAsync();
    if (!available) return doFallback();
  } catch {
    return doFallback();
  }

  try {
    const token = getAccessToken();
    const safeName = String(quoteNo || id).replace(/[^A-Za-z0-9_-]/g, '_');
    const dest = `${FileSystem.cacheDirectory}${safeName}.pdf`;
    const res = await FileSystem.downloadAsync(
      `${CONFIG.API_BASE_URL}/crm/quotes/${id}/pdf?disposition=attachment`,
      dest,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    if (res.status && res.status >= 400) return doFallback('Could not fetch the quotation PDF');
    await Sharing.shareAsync(res.uri, {
      mimeType: 'application/pdf',
      dialogTitle: `Share quotation ${quoteNo}`,
      UTI: 'com.adobe.pdf',
    });
    maybeMarkSent();
  } catch (e: any) {
    doFallback(e?.message || 'Could not share the PDF');
  }
}
