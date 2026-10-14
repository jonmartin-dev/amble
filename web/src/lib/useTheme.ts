import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Member, type Session } from './api.ts';
import { useMe } from './queries.ts';
import { applyTheme, defaultTheme, loadLocalTheme, type ThemePrefs } from './theme.ts';

/** Current theme with a setter that applies instantly and saves to the member (debounced). */
export function useTheme() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [prefs, setPrefs] = useState<ThemePrefs>(() => ({ ...defaultTheme, ...(me?.theme ?? loadLocalTheme()) }));
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const save = useMutation({
    mutationFn: (theme: ThemePrefs) => api<{ member: Member }>('/me', { method: 'PATCH', body: JSON.stringify({ theme }) }),
    onSuccess: ({ member }) => queryClient.setQueryData<Session>(['session'], (s) => (s ? { ...s, member } : s)),
  });

  const update = useCallback(
    (patch: Partial<ThemePrefs>) => {
      setPrefs((current) => {
        const next = { ...current, ...patch };
        applyTheme(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => save.mutate(next), 500);
        return next;
      });
    },
    [save],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return { prefs, update, saving: save.isPending, error: save.error };
}

/** Applies the signed-in member's saved theme when it differs from this device's copy. */
export function useSyncMemberTheme() {
  const me = useMe();
  useEffect(() => {
    if (!me?.theme) return;
    const local = loadLocalTheme();
    const remote = { ...defaultTheme, ...me.theme };
    if (JSON.stringify(local) !== JSON.stringify(remote)) applyTheme(remote);
  }, [me?.theme]);
}
