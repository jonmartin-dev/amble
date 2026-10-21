import { READ_CHOICES, setMotion, TOGGLES, useMotion, type Motion } from '../lib/motion-demo.ts';
import { Sheet, Switch } from './ui.tsx';

/** The motion still being tried out, from Settings: smart add's reading, and the extras. */
export function MotionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const motion = useMotion();
  return (
    <Sheet open={open} onClose={onClose} label="Motion" header={<p className="pb-1 font-medium">Motion</p>}>
      <div className="flex flex-col gap-5 pb-4">
        <section>
          <p className="mb-2 text-sm text-on-surface-variant">Smart add, while it reads</p>
          <div className="flex flex-wrap gap-2">
            {READ_CHOICES.map(([value, label]) => (
              <button key={value} type="button" aria-pressed={motion.read === value} onClick={() => setMotion({ read: value })} className="chip">
                {label}
              </button>
            ))}
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <p className="mb-1 text-sm text-on-surface-variant">Extras</p>
          {TOGGLES.map(([key, label]) => (
            <label key={key} className="flex items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1">{label}</span>
              <Switch checked={motion[key]} onChange={(v) => setMotion({ [key]: v } as Partial<Motion>)} label={label} />
            </label>
          ))}
        </section>
      </div>
    </Sheet>
  );
}
