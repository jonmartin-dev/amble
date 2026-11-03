import { motion } from 'motion/react';
import { useMemo, type ReactNode } from 'react';
import AutoMode from '~icons/material-symbols/brightness-auto-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import DarkMode from '~icons/material-symbols/dark-mode-outline-rounded';
import LightMode from '~icons/material-symbols/light-mode-outline-rounded';
import { ButtonGroup, SubpageHeader } from '../components/ui.tsx';
import { expressive } from '../lib/motion.ts';
import { palettes, type Palette } from '../lib/palettes.ts';
import { hasPhoneColors, paletteOf, previewColors, type ThemeContrast, type ThemeMode, type ThemePrefs } from '../lib/theme.ts';
import { EDGES, setEdge, useEdge } from '../lib/top-edge.ts';
import { useTheme } from '../lib/useTheme.ts';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-3 px-1 text-sm font-medium text-primary">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A palette in its own colors, whatever the app is in now: its load card, a chip of each accent,
 * and its name, so it can be judged before it's picked.
 */
function PaletteCard({ palette, name, mood, selected, prefs, onPick }: { palette: Palette | 'phone'; name: string; mood: string; selected: boolean; prefs: ThemePrefs; onPick: () => void }) {
  const dark = document.documentElement.dataset.mode === 'dark' || (prefs.mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const c = useMemo(() => previewColors(palette, dark), [palette, dark]);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={`${name}: ${mood}`}
      onClick={onPick}
      style={{ background: c.surface, color: c.onSurface }}
      className={`press-soft relative flex flex-col gap-2 rounded-3xl p-2.5 text-left ${selected ? 'outline-2 outline-offset-2 outline-primary' : 'outline-1 outline-outline-variant'}`}
    >
      <span className="flex h-12 flex-col justify-end rounded-2xl p-2.5" style={{ background: c.primaryContainer }}>
        <span className="h-1.5 overflow-hidden rounded-full" style={{ background: `color-mix(in srgb, ${c.onPrimaryContainer} 15%, transparent)` }}>
          <span className="block h-full w-3/5 rounded-full" style={{ background: c.primary }} />
        </span>
      </span>
      <span className="flex items-center gap-1.5 px-0.5">
        <span className="h-4 w-8 rounded-full" style={{ background: c.secondaryContainer }} />
        <span className="h-4 w-5 rounded-full" style={{ background: c.tertiaryContainer }} />
        <span className="ml-auto size-4 rounded-md" style={{ background: c.primary }} />
      </span>
      <span className="px-1 pb-0.5">
        <span className="block font-medium">{name}</span>
        <span className="block text-xs leading-snug" style={{ color: c.onSurfaceVariant }}>
          {mood}
        </span>
      </span>
      {selected && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={expressive.fastSpatial}
          className="absolute top-4 right-4 grid size-6 place-items-center rounded-full"
          style={{ background: c.primary, color: c.surface }}
        >
          <Check className="size-4" aria-hidden />
        </motion.span>
      )}
    </button>
  );
}

export function Appearance() {
  const { prefs, update } = useTheme();
  const edge = useEdge();
  // The phone's own colors, on Android 12 and later; a browser has none to offer.
  const phone = hasPhoneColors();
  const fromPhone = phone && prefs.phone;
  const picked = paletteOf(prefs);

  return (
    <>
      <SubpageHeader title="Appearance" />

      <Section title="Palette">
        <div role="radiogroup" aria-label="Palette" className="grid grid-cols-2 gap-3 medium:grid-cols-3">
          {palettes.map((p) => (
            <PaletteCard
              key={p.id}
              palette={p}
              name={p.name}
              mood={p.mood}
              prefs={prefs}
              selected={!fromPhone && picked.id === p.id}
              // The seed too, so a device still on a version from before palettes shows something close.
              onPick={() => update({ palette: p.id, seed: p.seed, style: 'tonal', phone: false })}
            />
          ))}
          {phone && <PaletteCard palette="phone" name="Your phone's" mood="Follows your wallpaper" prefs={prefs} selected={fromPhone} onPick={() => update({ phone: true })} />}
        </div>
        {fromPhone && <p className="mt-2 px-1 text-sm text-on-surface-variant">Your phone's colors change with its wallpaper. Devices without them use {picked.name}.</p>}
      </Section>

      <Section title="Light or dark">
        <ButtonGroup<ThemeMode>
          label="Light or dark"
          value={prefs.mode}
          onChange={(mode) => update({ mode })}
          options={[
            { value: 'light', label: 'Light', icon: <LightMode className="size-5" aria-hidden /> },
            { value: 'dark', label: 'Dark', icon: <DarkMode className="size-5" aria-hidden /> },
            { value: 'system', label: 'Auto', icon: <AutoMode className="size-5" aria-hidden /> },
          ]}
        />
      </Section>

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

      <Section title="Top of the screen">
        <Choices label="Top of the screen" value={edge} options={edges} onPick={setEdge} />
        <p className="mt-2 px-1 text-sm text-on-surface-variant">What the status bar does once a page scrolls up under it. Just on this device while you try them.</p>
      </Section>

      <p className="mt-6 px-1 text-sm text-on-surface-variant">The rest is saved to your account, so it follows you to every device.</p>
    </>
  );
}

const edges = EDGES.map(([id, name, hint]) => ({ id, name, hint }));

/** One of a few, each with a line on what it does: a column of rows, the picked one filled. */
function Choices<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly { id: T; name: string; hint: string }[]; onPick: (id: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col gap-1">
      {options.map((s, i) => {
        const on = value === s.id;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(s.id)}
            className={`flex items-center gap-4 px-4 py-3 text-left transition-colors ${on ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-low'} ${
              i === 0 ? 'rounded-t-3xl rounded-b-md' : i === options.length - 1 ? 'rounded-t-md rounded-b-3xl' : 'rounded-md'
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
  );
}
