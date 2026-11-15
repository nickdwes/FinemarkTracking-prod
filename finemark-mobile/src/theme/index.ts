/**
 * Finemark Mobile — "Neon Glass" design tokens.
 *
 * Dark, high-tech, command-center aesthetic: deep navy/black base, frosted-glass
 * surfaces (semi-transparent + blur), cyan + violet neon accents, and status colors
 * that mirror the web portal's statusBadgeClass (green / amber / red / violet).
 *
 * This is the single source of truth for color, spacing, radius and type. Components
 * in src/components/ui consume it — there is no NativeWind/Tailwind layer; the glass
 * look is custom (expo-linear-gradient + expo-blur), which utility classes can't give.
 */

export const colors = {
  // Base canvas (two-tone for depth)
  bg: '#070B14',
  bgElevated: '#0B1220',
  bgSheet: '#0E1626',

  // Frosted glass surfaces (used over the canvas / gradients)
  glass: 'rgba(20, 30, 48, 0.55)',
  glassStrong: 'rgba(20, 30, 48, 0.78)',
  glassBorder: 'rgba(120, 160, 220, 0.18)',
  glassBorderNeon: 'rgba(34, 211, 238, 0.35)',

  // Neon accents
  cyan: '#22D3EE',
  cyanDim: 'rgba(34, 211, 238, 0.14)',
  violet: '#8B5CF6',
  violetDim: 'rgba(139, 92, 246, 0.16)',

  // Text
  text: '#EAF1FB',
  textMuted: '#93A4C0',
  textFaint: '#5E7192',

  // Status (aligned with web job statuses)
  green: '#34D399',
  greenDim: 'rgba(52, 211, 153, 0.15)',
  amber: '#FBBF24',
  amberDim: 'rgba(251, 191, 36, 0.15)',
  red: '#F87171',
  redDim: 'rgba(248, 113, 113, 0.15)',
  blue: '#60A5FA',
  blueDim: 'rgba(96, 165, 250, 0.15)',

  white: '#FFFFFF',
  black: '#000000',
  transparent: 'transparent',
} as const;

/** Background gradient used behind screens (deep navy → near-black with a violet cast). */
export const bgGradient = ['#0A1120', '#070B14', '#0B0A18'] as const;
/** Primary CTA gradient (cyan → violet). */
export const neonGradient = ['#22D3EE', '#6366F1', '#8B5CF6'] as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

export const font = {
  // System stack; numerals use the platform mono for the "technical" feel where wanted.
  size: {
    xs: 11,
    sm: 13,
    md: 15,
    lg: 18,
    xl: 22,
    xxl: 28,
    display: 34,
  },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const;

/** Map a job/ticket/lead status string → { fg, bg } neon status colors. */
export function statusColors(status?: string | null): { fg: string; bg: string } {
  const s = (status || '').toLowerCase();
  // 'superseded' checked before the green/red buckets — it's a distinct terminal
  // state (a quote revised into a newer one), colored purple to match web's
  // crm-quote-detail.html / crm-quotes.html STATUS_COLORS (bg-purple-50/text-purple-700).
  if (s.includes('superseded'))
    return { fg: colors.violet, bg: colors.violetDim };
  if (['completed', 'closed', 'approved', 'accepted', 'installed', 'active', 'qualified', 'converted'].some((k) => s.includes(k)))
    return { fg: colors.green, bg: colors.greenDim };
  if (['inprogress', 'in progress', 'assigned', 'travel', 'arrived', 'pending approval', 'sent'].some((k) => s.includes(k)))
    return { fg: colors.cyan, bg: colors.cyanDim };
  if (['on hold', 'rescheduled', 'reserved', 'awaiting', 'draft', 'new'].some((k) => s.includes(k)))
    return { fg: colors.amber, bg: colors.amberDim };
  if (['cancelled', 'canceled', 'defaulted', 'rejected', 'disqualified', 'defective', 'failed', 'overdue'].some((k) => s.includes(k)))
    return { fg: colors.red, bg: colors.redDim };
  return { fg: colors.blue, bg: colors.blueDim };
}

export const shadowNeon = {
  shadowColor: colors.cyan,
  shadowOpacity: 0.35,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 4 },
  elevation: 8,
} as const;

export type ThemeColors = typeof colors;
