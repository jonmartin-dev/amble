import { useCallback, useEffect, useRef, useState } from 'react';
import { useSaveMe } from './mutations.ts';
import { useMe } from './queries.ts';
import { applyTheme, loadLocalTheme, withDefaults, type ThemePrefs } from './theme.ts';

/** Current theme with a setter that applies instantly and saves to the member (debounced, and offline too). */
export function useTheme() {
  const me = useMe();
  const saveMe = useSaveMe();
  const [prefs, setPrefs] = useState<ThemePrefs>(() => (me?.theme ? withDefaults(me.theme) : loadLocalTheme()));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const update = useCallback(
    (patch: Partial<ThemePrefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        applyTheme(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => saveMe({ theme: next }, 'Change the theme'), 500);
        return next;
      });
    },
    [saveMe],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return { prefs, update };
}

/** Applies the signed-in member's saved theme when it differs from this device's copy. */
export function useSyncMemberTheme() {
  const me = useMe();
  useEffect(() => {
    if (!me?.theme) return;
    const local = loadLocalTheme();
    const remote = withDefaults(me.theme);
    if (JSON.stringify(local) !== JSON.stringify(remote)) applyTheme(remote);
  }, [me?.theme]);
}
