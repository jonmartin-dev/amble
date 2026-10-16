import { useState } from 'react';
import ErrorIcon from '~icons/material-symbols/error-outline-rounded';
import { findServer, signInToServer } from '../lib/server-sync.ts';

/**
 * The address of the household's own server, then off to sign in there. `action` is what the page
 * carries on with once the server sends the person back (see useServerReturn).
 */
export function ServerForm({ action, onCancel }: { action: string; onCancel?: () => void }) {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInToServer(await findServer(address.trim()), action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void go(e)} className="flex flex-col gap-3 rounded-3xl bg-surface-low p-4">
      <label className="flex flex-col gap-2">
        <span className="font-medium">Your server's address</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          placeholder="amble.example.com"
          className="rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant focus-visible:ring-2 focus-visible:ring-primary"
        />
      </label>
      <p className="px-1 text-sm text-on-surface-variant">
        The Amble server your household runs, at home or through Tailscale, like amble.example.com or 192.168.1.20:18085. You sign in there the
        way that server lets you.
      </p>
      {error && (
        <p role="alert" className="flex gap-2 text-error">
          <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-full px-4 py-2 text-sm font-medium">
            Cancel
          </button>
        )}
        <button type="submit" disabled={!address.trim() || busy} className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-40">
          {busy ? 'Looking…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}
