import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import { api } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { GroupIcon, tone } from './icons.tsx';
import { Chip, Sheet } from './ui.tsx';

const colors = ['green', 'teal', 'lime', 'blue', 'violet', 'orange', 'rose'];
const icons = ['folder', 'home', 'directions-car', 'call', 'rocket-launch', 'palette', 'shopping-cart'];

export function NewGroupSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'tasks' | 'list'>('tasks');
  const [color, setColor] = useState('blue');
  const [icon, setIcon] = useState('folder');
  const [isPrivate, setPrivate] = useState(false);

  const create = useMutation({
    mutationFn: () => api('/groups', { method: 'POST', body: JSON.stringify({ name, kind, color, icon, private: isPrivate }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
      snack({ message: `Made ${name}` });
      setName('');
      onClose();
    },
    onError: (e: Error) => snack({ message: e.message }),
  });

  return (
    <Sheet open={open} onClose={onClose} label="New group or list">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <p className="display text-2xl font-medium">New {kind === 'list' ? 'list' : 'group'}</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'list' ? 'Packing, Hardware store…' : 'Garden, Car, Taxes…'}
          aria-label="Name"
          className="mt-4 w-full rounded-2xl bg-surface-high px-4 py-3.5 text-lg outline-none placeholder:text-on-surface-variant"
        />
        <div className="mt-4 flex gap-2">
          <Chip selected={kind === 'tasks'} onClick={() => setKind('tasks')}>
            Tasks
          </Chip>
          <Chip selected={kind === 'list'} onClick={() => setKind('list')}>
            Shopping-style list
          </Chip>
          <Chip selected={isPrivate} onClick={() => setPrivate((v) => !v)}>
            Only me
          </Chip>
        </div>
        <div className="mt-5 flex flex-wrap gap-2" role="radiogroup" aria-label="Icon">
          {icons.map((i) => (
            <motion.button
              key={i}
              type="button"
              role="radio"
              aria-checked={icon === i}
              aria-label={i}
              onClick={() => setIcon(i)}
              animate={{ borderRadius: icon === i ? 14 : 999 }}
              transition={expressive.fastSpatial}
              className={`grid size-11 place-items-center ${icon === i ? tone(color) : 'bg-surface-high text-on-surface-variant'}`}
            >
              <GroupIcon name={i} className="size-5" />
            </motion.button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={`grid size-11 place-items-center rounded-full ${tone(c)}`}
            >
              {color === c && <Check className="size-5" aria-hidden />}
            </button>
          ))}
        </div>
        <button
          type="submit"
          disabled={!name.trim() || create.isPending}
          className="mt-6 w-full rounded-full bg-primary py-3.5 font-medium text-on-primary disabled:opacity-50"
        >
          Create
        </button>
      </form>
    </Sheet>
  );
}
