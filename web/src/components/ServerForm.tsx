import { useEffect, useState } from 'react';
import ErrorIcon from '~icons/material-symbols/error-outline-rounded';
import QrScanner from '~icons/material-symbols/qr-code-scanner-rounded';
import { joinCodeFrom, serverFromCode } from '../../../shared/qr.ts';
import { servedBy } from '../lib/api.ts';
import { native, scanCode } from '../lib/native.ts';
import { findServer, pairWithServer, signInToServer, type FoundServer } from '../lib/server-sync.ts';

const field = 'rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant focus-visible:ring-2 focus-visible:ring-primary';

/**
 * Getting this device into the household's own server: its address, typed or scanned, and a code
 * from a phone or computer that's already in (the scanned code carries both), with a name if the
 * code brings in someone new. A server with a sign-in provider offers that too, and one from before
 * codes only that: off to sign in there, and `action` is what the page carries on with once the
 * server sends the person back (see useServerReturn). `joined` runs once the device is in.
 */
export function ServerForm({
  action,
  onCancel,
  joined,
  code: given,
  address: known,
}: {
  action: string;
  onCancel?: () => void;
  joined: () => void;
  code?: string | null;
  /** The household's server, when it's already known. */
  address?: string | null;
}) {
  // Opened from an Amble server, that's most likely the one.
  const [address, setAddress] = useState(known ?? servedBy?.url ?? '');
  const [found, setFound] = useState<FoundServer | null>(null);
  const [code, setCode] = useState(given ?? '');
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const pair = (server: FoundServer, withCode: string, withName?: string) =>
    attempt(async () => {
      if ((await pairWithServer(server.url, withCode, withName)) === 'name') setName('');
      else joined();
    });

  /** The server at an address, then a code if there is one; a server from before codes goes to sign in. */
  const look = (typed: string, withCode?: string) =>
    attempt(async () => {
      const server = await findServer(typed);
      setFound(server);
      if (!server.pairing) return void (await signInToServer(server.url, action));
      if (withCode) {
        if ((await pairWithServer(server.url, withCode)) === 'name') setName('');
        else joined();
      }
    });

  // Opened from a join link with its code: straight in.
  useEffect(() => {
    if (given && servedBy) void look(servedBy.url, given);
    // Once, for the code it opened with.
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!found) {
      if (address.trim()) void look(address.trim(), code.trim() || undefined);
    } else if (name != null) {
      if (name.trim()) void pair(found, code.trim(), name.trim());
    } else if (code.trim()) void pair(found, code.trim());
  };

  // A scanned code has the address and, from a device that's in, the code to get in with.
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
    const scannedCode = joinCodeFrom(text);
    setAddress(scanned);
    setFound(null);
    setName(null);
    if (scannedCode) setCode(scannedCode);
    void look(scanned, scannedCode ?? undefined);
  };

  const host = found ? new URL(found.url).host : null;

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-3xl bg-surface-low p-4">
      {native && !found && (
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
            It’s in Settings, Your server, Add a phone or computer, on a device that’s already in. Or type the address:
          </p>
        </>
      )}

      {!found ? (
        <>
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
              className={field}
            />
          </label>
          <p className="px-1 text-sm text-on-surface-variant">
            The Amble server your household runs, at home or through Tailscale, like amble.example.com or 192.168.1.20:18085.
          </p>
        </>
      ) : name == null ? (
        <>
          <label className="flex flex-col gap-2">
            <span className="font-medium">The code from {host}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              spellCheck={false}
              autoFocus
              placeholder="ABCD-EFGH"
              className={`${field} text-lg tracking-widest`}
            />
          </label>
          <p className="px-1 text-sm text-on-surface-variant">
            On a phone or computer that’s already in, open Amble’s Settings, Your server, and choose Add a phone or computer. A new server’s first code
            comes from its setup script.
          </p>
          {found.signIn && (
            <button type="button" onClick={() => void signInToServer(found.url, action)} disabled={busy} className="-ml-2 h-10 self-start rounded-full px-3 text-sm font-medium text-primary">
              Sign in with {found.signIn} instead
            </button>
          )}
        </>
      ) : (
        <label className="flex flex-col gap-2">
          <span className="font-medium">What should Amble call you?</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="given-name"
            autoFocus
            maxLength={80}
            placeholder="Your first name"
            className={field}
          />
          <span className="px-1 text-sm text-on-surface-variant">You’re new to this household, so {host} needs a name for you.</span>
        </label>
      )}

      {error && (
        <p role="alert" className="flex gap-2 text-error">
          <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {(onCancel || found) && (
          <button
            type="button"
            onClick={() => {
              if (found) {
                setFound(null);
                setName(null);
                setError(null);
              } else onCancel?.();
            }}
            className="rounded-full px-4 py-2 text-sm font-medium"
          >
            {found ? 'Back' : 'Cancel'}
          </button>
        )}
        <button
          type="submit"
          disabled={busy || (!found ? !address.trim() : name == null ? !code.trim() : !name.trim())}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {busy ? (found ? 'Joining…' : 'Looking…') : 'Continue'}
        </button>
      </div>
    </form>
  );
}
