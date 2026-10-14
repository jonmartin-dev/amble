import { AnimatePresence, usePresence } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

interface Snack {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

const SnackbarContext = createContext<(snack: Omit<Snack, 'id'>) => void>(() => {});

/** M3 snackbar: one at a time, above the toolbar, with an optional action such as Undo. */
export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [snack, setSnack] = useState<Snack | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nextId = useRef(0);

  const show = useCallback((s: Omit<Snack, 'id'>) => {
    clearTimeout(timer.current);
    const id = ++nextId.current;
    setSnack({ ...s, id });
    timer.current = setTimeout(() => setSnack((cur) => (cur?.id === id ? null : cur)), s.action ? 6000 : 3500);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <SnackbarContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4"
        style={{ bottom: 'calc(max(1.25rem, env(safe-area-inset-bottom)) + 5.5rem + var(--status-pill, 0rem))', transition: 'bottom 0.25s ease' }}
      >
        <AnimatePresence>
          {snack && (
            <SnackCard key={snack.id}>
              <p className="flex-1 py-1.5 text-sm">{snack.message}</p>
              {snack.action && (
                <button
                  type="button"
                  onClick={() => {
                    snack.action!.run();
                    setSnack(null);
                  }}
                  className="rounded-full px-3 py-2 text-sm font-medium text-primary-container"
                >
                  {snack.action.label}
                </button>
              )}
            </SnackCard>
          )}
        </AnimatePresence>
      </div>
    </SnackbarContext.Provider>
  );
}

/** Rises in and drops away as browser animations, which stay smooth while the page is busy. */
function SnackCard({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [isPresent, safeToRemove] = usePresence();
  useEffect(() => {
    if (isPresent) return;
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return safeToRemove();
    el.style.pointerEvents = 'none';
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(12px) scale(0.98)' }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
      .finished.then(safeToRemove, safeToRemove);
  }, [isPresent, safeToRemove]);
  return (
    <div ref={ref} className="snack-in pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-on-surface py-2 pr-2 pl-4 text-surface shadow-lg">
      {children}
    </div>
  );
}

export const useSnackbar = () => useContext(SnackbarContext);
