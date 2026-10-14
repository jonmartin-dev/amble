import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import PersonAdd from '~icons/material-symbols/person-add-outline-rounded';
import { Avatar } from '../components/Avatar.tsx';
import { SectionTitle, SubpageHeader } from '../components/ui.tsx';
import { api, type HouseholdMember } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useMe, useMembers } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

export function Household() {
  const me = useMe();
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { data } = useMembers();
  const [adding, setAdding] = useState<{ email: string; name: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const admin = me?.role === 'admin';
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['session'] });
  };
  const onError = (e: Error) => snack({ message: e.message });

  const add = useMutation({
    mutationFn: (p: { email: string; name: string }) => api('/members', { method: 'POST', body: JSON.stringify(p) }),
    onSuccess: (_, p) => {
      snack({ message: `Added ${p.name}` });
      setAdding(null);
    },
    onError,
    onSettled: refresh,
  });
  const rename = useMutation({
    mutationFn: (p: { id: string; name: string }) => api(`/members/${p.id}`, { method: 'PATCH', body: JSON.stringify({ name: p.name }) }),
    onSuccess: () => setRenaming(null),
    onError,
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (m: HouseholdMember) => api(`/members/${m.id}`, { method: 'DELETE' }),
    onSuccess: (_, m) => snack({ message: `Removed ${m.name}` }),
    onError,
    onSettled: refresh,
  });

  return (
    <>
      <SubpageHeader title="Household" />
      <p className="px-1 text-on-surface-variant">Everyone here shares groups and lists, and can hand tasks to each other.</p>

      <ul className="mt-5 flex flex-col gap-2">
        {data?.members.map((m) => (
          <li key={m.id} className="rounded-3xl bg-surface-low p-4">
            <div className="flex items-center gap-4">
              <Avatar member={m} size={44} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {m.name}
                  {m.id === me?.id && <span className="font-normal text-on-surface-variant"> (you)</span>}
                </p>
                <p className="truncate text-sm text-on-surface-variant">{m.email}</p>
                {(m.role === 'admin' || !m.signedIn) && (
                  <p className="text-sm text-on-surface-variant">{m.role === 'admin' ? 'Admin' : "Hasn't signed in yet"}</p>
                )}
              </div>
              {(admin || m.id === me?.id) && (
                <button
                  type="button"
                  onClick={() => setRenaming({ id: m.id, name: m.name })}
                  className="rounded-full px-3 py-2 text-sm font-medium text-primary hover:bg-surface-high"
                >
                  Rename
                </button>
              )}
            </div>
            <AnimatePresence>
              {renaming?.id === m.id && (
                <motion.form
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={expressive.defaultSpatial}
                  className="overflow-hidden"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (renaming.name.trim()) rename.mutate(renaming);
                  }}
                >
                  <div className="mt-3 flex gap-2">
                    <input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      aria-label="Name"
                      autoFocus
                      className="min-w-0 flex-1 rounded-2xl bg-surface-high px-4 py-3 outline-none"
                    />
                    <button type="submit" className="rounded-2xl bg-primary px-4 font-medium text-on-primary">
                      Save
                    </button>
                  </div>
                  {admin && m.role !== 'admin' && (
                    <button
                      type="button"
                      onClick={() => confirm(`Remove ${m.name} from the household? Their tasks stay, unassigned.`) && remove.mutate(m)}
                      className="mt-2 rounded-full px-3 py-2 text-sm font-medium text-error hover:bg-surface-high"
                    >
                      Remove from household
                    </button>
                  )}
                </motion.form>
              )}
            </AnimatePresence>
          </li>
        ))}
      </ul>

      {admin && (
        <>
          <SectionTitle>Add someone</SectionTitle>
          {data?.pending.map((email) => (
            <button
              key={email}
              type="button"
              onClick={() => setAdding({ email, name: '' })}
              className="mb-2 flex w-full items-center gap-3 rounded-3xl bg-surface-low p-4 text-left"
            >
              <PersonAdd className="size-6 text-primary" aria-hidden />
              <span className="flex-1">
                <span className="block">{email}</span>
                <span className="block text-sm text-on-surface-variant">Allowed in the server settings, not added yet</span>
              </span>
            </button>
          ))}
          {!adding && (
            <button
              type="button"
              onClick={() => setAdding({ email: '', name: '' })}
              className="flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high"
            >
              <PersonAdd className="size-5" aria-hidden />
              Add a person
            </button>
          )}
          <AnimatePresence>
            {adding && (
              <motion.form
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={expressive.fastSpatial}
                className="flex flex-col gap-2 rounded-3xl bg-surface-low p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (adding.email.trim() && adding.name.trim()) add.mutate(adding);
                }}
              >
                <input
                  value={adding.name}
                  onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                  placeholder="Name"
                  aria-label="Name"
                  autoFocus
                  className="rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant"
                />
                <input
                  value={adding.email}
                  onChange={(e) => setAdding({ ...adding, email: e.target.value })}
                  placeholder="Their Google email"
                  aria-label="Email"
                  type="email"
                  className="rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant"
                />
                <p className="px-1 text-sm text-on-surface-variant">They can sign in with that account right away, and you can hand them tasks before they do.</p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setAdding(null)} className="rounded-full px-4 py-2 text-sm font-medium">
                    Cancel
                  </button>
                  <button type="submit" className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary">
                    Add
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>
        </>
      )}
    </>
  );
}
