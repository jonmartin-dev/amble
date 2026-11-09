import { argbFromHex, Blend, type DynamicColor, DynamicScheme, Hct, hexFromArgb, MaterialDynamicColors as C, TonalPalette, Variant } from '@material/material-color-utilities';
import { palettes, type Palette } from './palettes.ts';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeStyle = 'tonal' | 'expressive' | 'vibrant' | 'fidelity' | 'neutral';
export type ThemeContrast = 0 | 0.5 | 1;

export interface ThemePrefs {
  mode: ThemeMode;
  /** One of Amble's palettes (lib/palettes.ts), by id. */
  palette: string;
  /** The palette's nearest color as the themes before palettes knew it, with `style`, for a device still on an older version. */
  seed: string;
  style: ThemeStyle;
  contrast: ThemeContrast;
  /** The phone's own colors, where it has them (Android 12 and later); the palette everywhere else. */
  phone: boolean;
}

export const defaultTheme: ThemePrefs = { mode: 'system', palette: 'grove', seed: '#2e6a57', style: 'tonal', contrast: 0, phone: false };

/** Saved prefs filled out. A color picked before palettes becomes the palette nearest it. */
export function withDefaults(saved: Partial<ThemePrefs> | null | undefined): ThemePrefs {
  if (!saved) return defaultTheme;
  return { ...defaultTheme, phone: false, ...saved, palette: paletteOf(saved).id };
}

/** The palette prefs ask for: theirs, or for a color from before palettes, the one nearest it. */
export function paletteOf(prefs: Partial<Pick<ThemePrefs, 'palette' | 'seed'>>): Palette {
  const picked = palettes.find((p) => p.id === prefs.palette);
  if (picked) return picked;
  const seed = prefs.seed?.toLowerCase() ?? defaultTheme.seed;
  const old = OLD_SEEDS[seed];
  if (old) return palettes.find((p) => p.id === old)!;
  // Any other color: a grey one is Slate, the rest the palette closest in hue.
  const hct = Hct.fromInt(argbFromHex(seed));
  if (hct.chroma < 12) return palettes.find((p) => p.id === 'slate')!;
  const apart = (p: Palette) => Math.min(Math.abs(p.primary[0] - hct.hue), 360 - Math.abs(p.primary[0] - hct.hue));
  return palettes.filter((p) => p.id !== 'slate').reduce((a, b) => (apart(b) < apart(a) ? b : a));
}

// The colors people could pick before palettes, and the palette each became.
const OLD_SEEDS: Record<string, string> = {
  '#2e6a57': 'grove',
  '#0f6e78': 'tidepool',
  '#3a5ba9': 'harbor',
  '#6b55a8': 'dusk',
  '#a8476b': 'fig',
  '#b5562b': 'clay',
  '#a87a12': 'chamomile',
  '#56616b': 'slate',
};

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
function phonePalette(tones: string[]) {
  const key = tones.map((t) => Hct.fromInt(argbFromHex(t))).reduce((a, b) => (b.chroma > a.chroma ? b : a));
  return TonalPalette.fromHueAndChroma(key.hue, key.chroma);
}

function phoneScheme(colors: PhoneColors, dark: boolean, contrast: number): DynamicScheme {
  const primary = phonePalette(colors.accent1);
  return new DynamicScheme({
    sourceColorHct: primary.keyColor,
    variant: Variant.TONAL_SPOT,
    contrastLevel: contrast,
    isDark: dark,
    specVersion: '2025',
    platform: 'phone',
    primaryPalette: primary,
    secondaryPalette: phonePalette(colors.accent2),
    tertiaryPalette: phonePalette(colors.accent3),
    neutralPalette: phonePalette(colors.neutral1),
    neutralVariantPalette: phonePalette(colors.neutral2),
  });
}

/** A palette's scheme: each of its colors as the palette Material takes that role's tones from. */
export function paletteScheme(p: Palette, dark: boolean, contrast: number): DynamicScheme {
  const tones = ([hue, chroma]: readonly [number, number]) => TonalPalette.fromHueAndChroma(hue, chroma);
  return new DynamicScheme({
    sourceColorHct: Hct.from(p.primary[0], p.primary[1], 40),
    variant: Variant.TONAL_SPOT,
    contrastLevel: contrast,
    isDark: dark,
    specVersion: '2025',
    platform: 'phone',
    primaryPalette: tones(p.primary),
    secondaryPalette: tones(p.secondary),
    tertiaryPalette: tones(p.tertiary),
    neutralPalette: tones(p.neutral),
    neutralVariantPalette: tones(p.neutralVariant),
  });
}

export function buildScheme(prefs: ThemePrefs, dark: boolean): DynamicScheme {
  if (prefs.phone && phoneColors) return phoneScheme(phoneColors, dark, prefs.contrast);
  return paletteScheme(paletteOf(prefs), dark, prefs.contrast);
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

/**
 * Group, list and member colors, as places in the theme rather than fixed hues, so a household's
 * groups look like the theme they picked instead of a rainbow over it: the cool names sit around
 * its primary hue and the warm ones around its tertiary, a step of hue apart, as soft as the
 * theme's own accents. The names stay as they were saved; they're only ids now.
 */
const groupSlots: Record<string, ['primary' | 'tertiary', number]> = {
  blue: ['primary', -1.5],
  teal: ['primary', -0.5],
  green: ['primary', 0.5],
  violet: ['primary', 1.5],
  rose: ['tertiary', -1],
  orange: ['tertiary', 0],
  lime: ['tertiary', 1],
};
// Degrees of hue between neighboring slots: enough to tell groups apart, close enough to stay in the theme.
const SLOT_STEP = 24;

// Amber for busy days, harmonized like the group colors.
const WARM = '#c98a12';

function customTones(source: number, seed: number, dark: boolean) {
  return tonesOf(TonalPalette.fromInt(Blend.harmonize(source, seed)), dark);
}

function tonesOf(palette: TonalPalette, dark: boolean) {
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
  for (const [name, [role, at]] of Object.entries(groupSlots)) {
    const accent = role === 'primary' ? scheme.primaryPalette : scheme.tertiaryPalette;
    // A little more color than the accent itself, so a group's swatch reads as a color, but no
    // louder than a vivid wallpaper's own.
    const t = tonesOf(TonalPalette.fromHueAndChroma((accent.hue + at * SLOT_STEP + 360) % 360, Math.min(accent.chroma + 8, 48)), dark);
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

/** A palette's own colors (or the phone's), for a card that shows it before it's picked. */
export function previewColors(palette: Palette | 'phone', dark: boolean) {
  const scheme = palette === 'phone' ? (phoneColors ? phoneScheme(phoneColors, dark, 0) : paletteScheme(palettes[0]!, dark, 0)) : paletteScheme(palette, dark, 0);
  const c = (role: DynamicColor) => hexFromArgb(scheme.getArgb(role));
  return {
    surface: c(C.surface),
    onSurface: c(C.onSurface),
    onSurfaceVariant: c(C.onSurfaceVariant),
    primary: c(C.primary),
    primaryContainer: c(C.primaryContainer),
    onPrimaryContainer: c(C.onPrimaryContainer),
    secondaryContainer: c(C.secondaryContainer),
    tertiaryContainer: c(C.tertiaryContainer),
  };
}
