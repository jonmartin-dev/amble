import { argbFromHex, Contrast, Hct } from '@material/material-color-utilities';
import { describe, expect, it } from 'vitest';
import { defaultTheme, seeds, styles, themeVariables, type ThemePrefs } from './theme.ts';

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
  const cases: ThemePrefs[] = seeds.flatMap((s) => styles.map((st) => ({ ...defaultTheme, seed: s.hex, style: st.id })));

  it.each(cases)('keeps text readable for $seed / $style', (prefs) => {
    for (const dark of [false, true]) {
      const vars = themeVariables(prefs, dark);
      for (const [fg, bg] of pairs) {
        expect(ratio(vars[fg]!, vars[bg]!), `${fg} on ${bg} (${dark ? 'dark' : 'light'})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('gives the default seed a green primary in light mode', () => {
    const hue = Hct.fromInt(argbFromHex(themeVariables(defaultTheme, false)['--md-primary']!)).hue;
    expect(hue).toBeGreaterThan(120);
    expect(hue).toBeLessThan(200);
  });
});
