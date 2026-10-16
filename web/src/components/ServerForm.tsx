import { useState } from 'react';
import ErrorIcon from '~icons/material-symbols/error-outline-rounded';
import QrScanner from '~icons/material-symbols/qr-code-scanner-rounded';
import { serverFromCode } from '../../../shared/qr.ts';
import { servedBy } from '../lib/api.ts';
import { native, scanCode } from '../lib/native.ts';
import { findServer, signInToServer } from '../lib/server-sync.ts';

/**
 * The address of the household's own server, typed or, in the Android app, scanned from the code on
 * the server's page; then off to sign in there. `action` is what the page carries on with once the
 * server sends the person back (see useServerReturn).
 */
export function ServerForm({ action, onCancel }: { action: string; onCancel?: () => void }) {
  // Opened from an Amble server, that's most likely the one.
  const [address, setAddress] = useState(servedBy?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async (typed: string) => {
    setBusy(true);
    setError(null);
    try {
      await signInToServer(await findServer(typed), action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
      setBusy(false);
    }
  };

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    if (address.trim() && !busy) void join(address.trim());
  };

  // A scanned code goes straight on to signing in.
  const scan = async () => {
    setError(null);
    let text: string | null;
    try {
      text = await scanCode();
    } catch (err) {
      setError(err instanceof Error ? `Couldn't scan: ${err.message}` : "Couldn't scan. Type the address instead.");
      return;
    }
    if (!text) return;
    const scanned = serverFromCode(text);
    setAddress(scanned);
    void join(scanned);
  };

  return (
    <form onSubmit={go} className="flex flex-col gap-3 rounded-3xl bg-surface-low p-4">
      {native && (
        <>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={busy}
            className="flex items-center justify-center gap-2 rounded-full bg-secondary-container px-5 py-3 font-medium text-on-secondary-container disabled:opacity-40"
          >
            <QrScanner className="size-5" aria-hidden />
            Scan the code
          </button>
          <p className="px-1 text-sm text-on-surface-variant">
            It’s on your server’s page, and in Settings, Sync and backup on a device already in step with it. Or type the address:
          </p>
        </>
      )}
      <label className="flex flex-col gap-2">
        <span className="font-medium">Your server's address</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={!native}
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
