import { motion } from 'motion/react';
import { useMemo, type ReactNode } from 'react';
import AutoMode from '~icons/material-symbols/brightness-auto-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import Colorize from '~icons/material-symbols/colorize-rounded';
import DarkMode from '~icons/material-symbols/dark-mode-outline-rounded';
import LightMode from '~icons/material-symbols/light-mode-outline-rounded';
import { ButtonGroup, SubpageHeader } from '../components/ui.tsx';
import { expressive } from '../lib/motion.ts';
import { hasPhoneColors, seeds, styles, swatchColors, type ThemeContrast, type ThemeMode, type ThemePrefs } from '../lib/theme.ts';
import { useTheme } from '../lib/useTheme.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-3 px-1 text-sm font-medium text-primary">{title}</h2>
      {children}
    </section>
  );
}

/** Android-style wallpaper swatch: primary on top, secondary and tertiary below. */
function Swatch({ hex, selected, prefs, onPick, label }: { hex: string | 'phone'; selected: boolean; prefs: ThemePrefs; onPick: () => void; label: string }) {
  const dark = document.documentElement.dataset.mode === 'dark' || (prefs.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const c = useMemo(() => swatchColors(hex, prefs.style, dark), [hex, prefs.style, dark]);
  return (
    <motion.button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onPick}
      // In percent, both ways: from 999px the change would only show at the very end.
      animate={{ borderRadius: selected ? '28%' : '50%' }}
      whileTap={{ scale: 0.9 }}
      transition={expressive.fastSpatial}
      className="relative grid aspect-square w-full place-items-center overflow-hidden bg-surface-high"
    >
      <span
        className="absolute inset-[14%] rounded-full"
        style={{ background: `conic-gradient(from -90deg, ${c.primary} 0 50%, ${c.tertiary} 50% 75%, ${c.secondary} 75% 100%)` }}
      />
      {selected && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={expressive.fastSpatial}
          className="relative grid size-7 place-items-center rounded-full bg-surface-lowest text-on-surface"
        >
          <Check className="size-5" aria-hidden />
        </motion.span>
      )}
    </motion.button>
  );
}

export function Appearance() {
  const { prefs, update } = useTheme();
  // The phone's own colors, on Android 12 and later; a browser has none to offer.
  const phone = hasPhoneColors();
  const fromPhone = phone && prefs.phone;
  const custom = !fromPhone && !seeds.some((s) => s.hex === prefs.seed);
  const seedName = seeds.find((s) => s.hex === prefs.seed)?.name;

  return (
    <>
      <SubpageHeader title="Appearance" />

      <div className="rounded-[2rem] bg-primary-container p-5 text-on-primary-container">
        <div className="flex items-baseline justify-between text-sm">
          <span>Today's load</span>
          <span className="display text-2xl font-medium">Light</span>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-on-primary-container/15">
          <div className="h-full w-[38%] rounded-full bg-primary" />
        </div>
        <div className="mt-4 flex items-center gap-3 rounded-2xl bg-surface-lowest p-3 text-on-surface">
          <span className="size-5 shrink-0 rounded-md border-2 border-primary" />
          <span className="flex-1 text-sm">Call the dentist</span>
          <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-on-primary">Add</span>
        </div>
        <div className="mt-2 rounded-2xl bg-warm-container p-3 text-sm text-on-warm-container">Saturday looks heavy</div>
      </div>

      <Section title="Theme">
        <ButtonGroup<ThemeMode>
          label="Theme"
          value={prefs.mode}
          onChange={(mode) => update({ mode })}
          options={[
            { value: 'light', label: 'Light', icon: <LightMode className="size-5" aria-hidden /> },
            { value: 'dark', label: 'Dark', icon: <DarkMode className="size-5" aria-hidden /> },
            { value: 'system', label: 'Auto', icon: <AutoMode className="size-5" aria-hidden /> },
          ]}
        />
      </Section>

      <Section title="Color">
        <div role="radiogroup" aria-label="Color" className="grid grid-cols-5 gap-3">
          {phone && <Swatch hex="phone" label="Your phone's colors" prefs={prefs} selected={fromPhone} onPick={() => update({ phone: true })} />}
          {seeds.map((s) => (
            <Swatch
              key={s.hex}
              hex={s.hex}
              label={s.name}
              prefs={prefs}
              selected={!fromPhone && prefs.seed === s.hex}
              onPick={() => update({ seed: s.hex, phone: false })}
            />
          ))}
          <label
            className={`relative grid aspect-square cursor-pointer place-items-center overflow-hidden bg-surface-high text-on-surface-variant ${custom ? 'rounded-[20px] outline-2 outline-primary' : 'rounded-full'}`}
            title="Pick any color"
          >
            <Colorize className="size-6" aria-hidden />
            <span className="sr-only">Pick any color</span>
            <input
              type="color"
              value={prefs.seed}
              onChange={(e) => update({ seed: e.target.value, phone: false })}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
        <p className="mt-2 px-1 text-sm text-on-surface-variant">
          {fromPhone
            ? `Your phone's colors, which follow its wallpaper and style. Devices without them use ${seedName ?? 'your color'}.`
            : (seedName ?? 'Your color')}
        </p>
      </Section>

      {!fromPhone && (
        <Section title="Style">
          <div role="radiogroup" aria-label="Style" className="flex flex-col gap-1">
            {styles.map((s, i) => {
              const on = prefs.style === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => update({ style: s.id })}
                  className={`flex items-center gap-4 px-4 py-3 text-left transition-colors ${on ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-low'} ${
                    i === 0 ? 'rounded-t-3xl rounded-b-md' : i === styles.length - 1 ? 'rounded-t-md rounded-b-3xl' : 'rounded-md'
                  }`}
                >
                  <span className="flex-1">
                    <span className="block font-medium">{s.name}</span>
                    <span className={`block text-sm ${on ? '' : 'text-on-surface-variant'}`}>{s.hint}</span>
                  </span>
                  {on && <Check className="size-6" aria-hidden />}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Contrast">
        <ButtonGroup<ThemeContrast>
          label="Contrast"
          value={prefs.contrast}
          onChange={(contrast) => update({ contrast })}
          options={[
            { value: 0, label: 'Standard' },
            { value: 0.5, label: 'Medium' },
            { value: 1, label: 'High' },
          ]}
        />
      </Section>

      <p className="mt-6 px-1 text-sm text-on-surface-variant">Saved to your account, so it follows you to every device.</p>
    </>
  );
}
