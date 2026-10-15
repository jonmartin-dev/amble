import {
  argbFromHex,
  Blend,
  type DynamicColor,
  DynamicScheme,
  Hct,
  hexFromArgb,
  MaterialDynamicColors as C,
  SchemeExpressive,
  SchemeFidelity,
  SchemeNeutral,
  SchemeTonalSpot,
  SchemeVibrant,
  TonalPalette,
  Variant,
} from '@material/material-color-utilities';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeStyle = 'tonal' | 'expressive' | 'vibrant' | 'fidelity' | 'neutral';
export type ThemeContrast = 0 | 0.5 | 1;

export interface ThemePrefs {
  mode: ThemeMode;
  seed: string;
  style: ThemeStyle;
  contrast: ThemeContrast;
  /** The phone's own colors, where it has them (Android 12 and later); `seed` everywhere else. */
  phone: boolean;
}

export const defaultTheme: ThemePrefs = { mode: 'system', seed: '#2e6a57', style: 'tonal', contrast: 0, phone: true };

/** Saved prefs filled out; someone who picked a color before phone colors existed keeps it. */
export function withDefaults(saved: Partial<ThemePrefs> | null | undefined): ThemePrefs {
  return saved ? { ...defaultTheme, phone: false, ...saved } : defaultTheme;
}

/**
 * The palettes Android 12 and later make from the wallpaper (Material You), each a few tones of
 * one hue, as hex: primary, secondary and tertiary accents, then the two neutrals.
 */
export interface PhoneColors {
  accent1: string[];
  accent2: string[];
  accent3: string[];
  neutral1: string[];
  neutral2: string[];
}

const PHONE_KEY = 'amble-phone-colors';

function savedPhoneColors(): PhoneColors | null {
  try {
    return JSON.parse(localStorage.getItem(PHONE_KEY) ?? 'null') as PhoneColors | null;
  } catch {
    return null;
  }
}

// Kept from last time, so the app opens in them before the phone answers.
let phoneColors = savedPhoneColors();

/** Whether this device has colors of its own to offer. */
export const hasPhoneColors = () => phoneColors !== null;

/** The phone's current palettes, or null where there are none; true if they changed. */
export function setPhoneColors(colors: PhoneColors | null): boolean {
  if (JSON.stringify(colors) === JSON.stringify(phoneColors)) return false;
  phoneColors = colors;
  try {
    if (colors) localStorage.setItem(PHONE_KEY, JSON.stringify(colors));
    else localStorage.removeItem(PHONE_KEY);
  } catch {
    // Only costs a moment in the chosen color at the next start.
  }
  return true;
}

/** Android makes each palette from a hue and a chroma; the tone with the most chroma shows them best. */
function paletteOf(tones: string[]) {
  const key = tones.map((t) => Hct.fromInt(argbFromHex(t))).reduce((a, b) => (b.chroma > a.chroma ? b : a));
  return TonalPalette.fromHueAndChroma(key.hue, key.chroma);
}

function phoneScheme(colors: PhoneColors, dark: boolean, contrast: number): DynamicScheme {
  const primary = paletteOf(colors.accent1);
  return new DynamicScheme({
    sourceColorHct: primary.keyColor,
    variant: Variant.TONAL_SPOT,
    contrastLevel: contrast,
    isDark: dark,
    specVersion: '2025',
    platform: 'phone',
    primaryPalette: primary,
    secondaryPalette: paletteOf(colors.accent2),
    tertiaryPalette: paletteOf(colors.accent3),
    neutralPalette: paletteOf(colors.neutral1),
    neutralVariantPalette: paletteOf(colors.neutral2),
  });
}

export const seeds = [
  { name: 'Grove', hex: '#2e6a57' },
  { name: 'Tide', hex: '#0f6e78' },
  { name: 'Ocean', hex: '#3a5ba9' },
  { name: 'Lavender', hex: '#6b55a8' },
  { name: 'Rose', hex: '#a8476b' },
  { name: 'Ember', hex: '#b5562b' },
  { name: 'Marigold', hex: '#a87a12' },
  { name: 'Slate', hex: '#56616b' },
];

export const styles: { id: ThemeStyle; name: string; hint: string }[] = [
  { id: 'tonal', name: 'Calm', hint: 'Soft, low-key color. The Android default.' },
  { id: 'expressive', name: 'Expressive', hint: 'Playful accents that drift from your color.' },
  { id: 'vibrant', name: 'Vibrant', hint: 'Bold, saturated surfaces.' },
  { id: 'fidelity', name: 'True to color', hint: 'Stays as close to your pick as possible.' },
  { id: 'neutral', name: 'Muted', hint: 'Nearly gray, with a hint of your color.' },
];

const schemeClasses = {
  tonal: SchemeTonalSpot,
  expressive: SchemeExpressive,
  vibrant: SchemeVibrant,
  fidelity: SchemeFidelity,
  neutral: SchemeNeutral,
};

export function buildScheme(prefs: ThemePrefs, dark: boolean): DynamicScheme {
  if (prefs.phone && phoneColors) return phoneScheme(phoneColors, dark, prefs.contrast);
  const Scheme = schemeClasses[prefs.style] ?? SchemeTonalSpot;
  return new Scheme(Hct.fromInt(argbFromHex(prefs.seed)), dark, prefs.contrast, '2025', 'phone');
}

const roles: Record<string, DynamicColor> = {
  primary: C.primary,
  'on-primary': C.onPrimary,
  'primary-container': C.primaryContainer,
  'on-primary-container': C.onPrimaryContainer,
  secondary: C.secondary,
  'secondary-container': C.secondaryContainer,
  'on-secondary-container': C.onSecondaryContainer,
  tertiary: C.tertiary,
  'tertiary-container': C.tertiaryContainer,
  'on-tertiary-container': C.onTertiaryContainer,
  error: C.error,
  surface: C.surface,
  'surface-lowest': C.surfaceContainerLowest,
  'surface-low': C.surfaceContainerLow,
  'surface-container': C.surfaceContainer,
  'surface-high': C.surfaceContainerHigh,
  'surface-highest': C.surfaceContainerHighest,
  'on-surface': C.onSurface,
  'on-surface-variant': C.onSurfaceVariant,
  outline: C.outline,
  'outline-variant': C.outlineVariant,
};

/** Fixed hues for groups and members. Harmonized toward the seed so they sit well with any theme. */
const groupHues: Record<string, string> = {
  green: '#4c9a6a',
  teal: '#2a9d9d',
  lime: '#8bb33a',
  blue: '#4a78d6',
  violet: '#8a63d2',
  orange: '#e07b2e',
  rose: '#d4537e',
};

// Amber for busy days, harmonized like the group colors.
const WARM = '#c98a12';

function customTones(source: number, seed: number, dark: boolean) {
  const palette = TonalPalette.fromInt(Blend.harmonize(source, seed));
  return dark
    ? { base: palette.tone(80), container: palette.tone(30), on: palette.tone(90) }
    : { base: palette.tone(40), container: palette.tone(90), on: palette.tone(10) };
}

export function themeVariables(prefs: ThemePrefs, dark: boolean): Record<string, string> {
  const scheme = buildScheme(prefs, dark);
  const seed = scheme.sourceColorArgb;
  const vars: Record<string, string> = {};
  for (const [name, color] of Object.entries(roles)) vars[`--md-${name}`] = hexFromArgb(scheme.getArgb(color));
  const warm = customTones(argbFromHex(WARM), seed, dark);
  vars['--md-warm'] = hexFromArgb(warm.base);
  vars['--md-warm-container'] = hexFromArgb(warm.container);
  vars['--md-on-warm-container'] = hexFromArgb(warm.on);
  for (const [name, hex] of Object.entries(groupHues)) {
    const t = customTones(argbFromHex(hex), seed, dark);
    vars[`--tone-${name}`] = hexFromArgb(t.container);
    vars[`--tone-${name}-on`] = hexFromArgb(t.on);
    // The strong shade, for chart bars and other fills that sit on a surface.
    vars[`--tone-${name}-base`] = hexFromArgb(t.base);
  }
  return vars;
}

const block = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');

const STORAGE_KEY = 'almanac-theme';

export function loadLocalTheme(): ThemePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return withDefaults(JSON.parse(raw) as Partial<ThemePrefs>);
  } catch {
    // Private mode or corrupt value: fall back to the default theme.
  }
  return defaultTheme;
}

export function applyTheme(prefs: ThemePrefs) {
  const light = themeVariables(prefs, false);
  const dark = themeVariables(prefs, true);
  const css =
    `:root{${block(light)}color-scheme:light}` +
    `@media (prefers-color-scheme: dark){:root:not([data-mode="light"]){${block(dark)}color-scheme:dark}}` +
    `:root[data-mode="dark"]{${block(dark)}color-scheme:dark}`;

  let el = document.getElementById('almanac-theme') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'almanac-theme';
    document.head.appendChild(el);
  }
  el.textContent = css;

  const root = document.documentElement;
  if (prefs.mode === 'system') delete root.dataset.mode;
  else root.dataset.mode = prefs.mode;

  const isDark = prefs.mode === 'dark' || (prefs.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = (isDark ? dark : light)['--md-surface']!;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Not fatal: the server copy still follows the member.
  }
}

/** Primary, secondary and tertiary of a seed (or the phone's colors), for the Android-style swatch preview. */
export function swatchColors(seed: string | 'phone', style: ThemeStyle, dark: boolean) {
  const scheme = seed === 'phone' && phoneColors ? phoneScheme(phoneColors, dark, 0) : buildScheme({ ...defaultTheme, phone: false, seed, style }, dark);
  return {
    primary: hexFromArgb(scheme.getArgb(C.primary)),
    secondary: hexFromArgb(scheme.getArgb(C.secondaryContainer)),
    tertiary: hexFromArgb(scheme.getArgb(C.tertiaryContainer)),
  };
}
