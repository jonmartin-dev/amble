import { AnimatePresence, usePresence } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface Snack {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

const SnackbarContext = createContext<(snack: Omit<Snack, 'id'>) => void>(() => {});

/**
 * M3 snackbar: one at a time, above the toolbar, with an optional action such as Undo. A message
 * that comes while one is up (three tasks ticked off in a row) takes its place on the same card;
 * one that comes while the last is still dropping away waits until it's gone, so two never meet.
 */
export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [snack, setSnack] = useState<Snack | null>(null);
  // The card on screen, by the id of the message it came up with.
  const [card, setCard] = useState(0);
  const up = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nextId = useRef(0);

  const hide = useCallback((id?: number) => {
    setSnack((cur) => {
      if (id !== undefined && cur?.id !== id) return cur;
      up.current = false;
      return null;
    });
  }, []);
  const show = useCallback(
    (s: Omit<Snack, 'id'>) => {
      clearTimeout(timer.current);
      const id = ++nextId.current;
      if (!up.current) setCard(id);
      up.current = true;
      setSnack({ ...s, id });
      timer.current = setTimeout(() => hide(id), s.action ? 6000 : 3500);
    },
    [hide],
  );

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <SnackbarContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4"
        style={{
          bottom: 'calc(max(1.25rem, env(safe-area-inset-bottom)) + var(--toolbar) + 0.75rem + var(--status-pill, 0rem))',
          paddingLeft: 'calc(var(--rail) + 1rem)',
          transition: 'bottom 0.25s ease',
        }}
      >
        <AnimatePresence mode="wait">
          {snack && (
            <SnackCard key={card}>
              {/* A message after the first on this card rises into it in place of the last. */}
              <div key={snack.id} className={`flex min-w-0 flex-1 items-center gap-3 ${snack.id === card ? '' : 'snack-swap'}`}>
                <p className="flex-1 py-1.5 text-sm">{snack.message}</p>
                {snack.action && (
                  <button
                    type="button"
                    onClick={() => {
                      // By its id: the action may have put up a message of its own.
                      const id = snack.id;
                      snack.action!.run();
                      hide(id);
                    }}
                    className="rounded-full px-3 py-2 text-sm font-medium text-primary-container"
                  >
                    {snack.action.label}
                  </button>
                )}
              </div>
            </SnackCard>
          )}
        </AnimatePresence>
      </div>
    </SnackbarContext.Provider>
  );
}

/**
 * Rises in and drops away as browser animations, which stay smooth while the page is busy. The way
 * out starts once, however often this renders while it goes (safeToRemove is a new function each
 * time).
 */
function SnackCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isPresent, safeToRemove] = usePresence();
  const remove = useRef(safeToRemove);
  remove.current = safeToRemove;
  useEffect(() => {
    if (isPresent) return;
    const done = () => remove.current?.();
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(12px) scale(0.98)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
      .finished.then(done, done);
  }, [isPresent]);
  return (
    <div ref={ref} className="snack-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-on-surface py-2 pr-2 pl-4 text-surface shadow-lg">
      {children}
    </div>
  );
}

export const useSnackbar = () => useContext(SnackbarContext);
