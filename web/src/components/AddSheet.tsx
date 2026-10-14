import { AnimatePresence, motion } from 'motion/react';
import { useEffect } from 'react';
import { expressive } from '../lib/motion.ts';

/** Bottom sheet for quick add. Saving tasks arrives with the core task loop (phase 2). */
export function AddSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            className="fixed inset-0 z-20 bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-label="Add a task"
            className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-xl rounded-t-[2rem] bg-surface-low px-5 pt-3"
            style={{ paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom))' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={expressive.defaultSpatial}
          >
            <div className="mx-auto mb-4 h-1 w-8 rounded-full bg-outline-variant" />
            <p className="display text-2xl font-medium">Quick add</p>
            <p className="mt-2 text-on-surface-variant">
              Typing things like "call mom tomorrow evening" lands in the next build, along with the backlog and day list.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-5 w-full rounded-full bg-primary py-3.5 font-medium text-on-primary active:scale-[0.98]"
            >
              Got it
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
