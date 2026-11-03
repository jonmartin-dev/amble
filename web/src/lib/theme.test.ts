import { argbFromHex, Contrast, Hct } from '@material/material-color-utilities';
import { describe, expect, it } from 'vitest';
import { palettes } from './palettes.ts';
import { defaultTheme, paletteOf, themeVariables, withDefaults, type ThemePrefs } from './theme.ts';

const tone = (hex: string) => Hct.fromInt(argbFromHex(hex)).tone;
const ratio = (a: string, b: string) => Contrast.ratioOfTones(tone(a), tone(b));

// Text pairs the UI actually renders; WCAG AA for body text is 4.5:1.
const pairs = [
  ['--md-on-surface', '--md-surface'],
  ['--md-on-surface-variant', '--md-surface-low'],
  ['--md-on-primary', '--md-primary'],
  ['--md-on-primary-container', '--md-primary-container'],
  ['--md-on-warm-container', '--md-warm-container'],
  ['--tone-blue-on', '--tone-blue'],
  ['--tone-orange-on', '--tone-orange'],
] as const;

describe('theme', () => {
  const cases: ThemePrefs[] = palettes.flatMap((p) => ([0, 0.5, 1] as const).map((contrast) => ({ ...defaultTheme, palette: p.id, contrast })));

  it.each(cases)('keeps text readable in $palette at contrast $contrast', (prefs) => {
    for (const dark of [false, true]) {
      const vars = themeVariables(prefs, dark);
      for (const [fg, bg] of pairs) {
        expect(ratio(vars[fg]!, vars[bg]!), `${fg} on ${bg} (${dark ? 'dark' : 'light'})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('moves a color picked before palettes to the palette nearest it', () => {
    expect(withDefaults({ seed: '#3a5ba9', style: 'vibrant' }).palette).toBe('harbor');
    expect(withDefaults({ seed: '#b5562b' }).palette).toBe('clay');
    expect(paletteOf({ seed: '#808080' }).id).toBe('slate');
    expect(paletteOf({ seed: '#1f8a8a' }).id).toBe('tidepool');
    expect(withDefaults({ palette: 'dusk', seed: '#2e6a57' }).palette).toBe('dusk');
  });

  it('gives the default palette a green primary in light mode', () => {
    const hue = Hct.fromInt(argbFromHex(themeVariables(defaultTheme, false)['--md-primary']!)).hue;
    expect(hue).toBeGreaterThan(120);
    expect(hue).toBeLessThan(200);
  });
});
