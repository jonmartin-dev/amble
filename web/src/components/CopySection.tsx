// Settings, Sync and backup: a copy of everything on this device as one file to keep, and putting
// one back. A device that syncs already has its household's copy, so it only saves.
import { useRef, useState } from 'react';
import Download from '~icons/material-symbols/download-rounded';
import Restore from '~icons/material-symbols/settings-backup-restore-rounded';
import { restoreCopy, saveCopy } from '../lib/copies.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { ListGroup, SectionTitle } from './ui.tsx';

/** Asks before putting a copy in place of what's here, and says why when it can't. */
export function useRestoreCopy() {
  const snack = useSnackbar();
  const [restoring, setRestoring] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const restore = async (file: File) => {
    if (!confirm(`Put the copy in ${file.name} in place of everything on this device? What's here now is replaced.`)) return;
    setRestoring(true);
    try {
      // Amble starts again on the copy once it's in place.
      await restoreCopy(file);
    } catch (e) {
      snack({ message: e instanceof Error ? e.message : "That copy couldn't be restored." });
      setRestoring(false);
    }
  };
  const input = (
    <input
      ref={picker}
      type="file"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void restore(file);
      }}
    />
  );
  return { pick: () => picker.current?.click(), restoring, input };
}

export function CopySection({ syncing }: { syncing: boolean }) {
  const snack = useSnackbar();
  const [saving, setSaving] = useState(false);
  const { pick, restoring, input } = useRestoreCopy();
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (await saveCopy()) snack({ message: 'Saved a copy.' });
    } catch (e) {
      snack({ message: e instanceof Error ? e.message : "Couldn't make a copy. Try again." });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SectionTitle>A copy to keep</SectionTitle>
      <ListGroup
        rows={[
          {
            icon: <Download className="size-6" />,
            title: saving ? 'Saving a copy…' : 'Save a copy',
            subtitle: 'Everything on this device in one file, photos and files on tasks included. Your AI key and sync sign-in stay out of it.',
            onClick: () => void save(),
          },
          ...(syncing
            ? []
            : [
                {
                  icon: <Restore className="size-6" />,
                  title: restoring ? 'Restoring…' : 'Restore a copy',
                  subtitle: 'Puts a saved copy in place of what’s on this device.',
                  onClick: () => !restoring && pick(),
                },
              ]),
        ]}
      />
      {syncing && (
        <p className="mt-2 px-1 text-sm text-on-surface-variant">Your household already keeps everything in step, so restoring a copy here is only for a device that doesn’t sync.</p>
      )}
      {input}
    </>
  );
}
