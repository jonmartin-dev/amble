// The first screen: three ways to start. On this device only (Amble asks what to call you), from
// Google Drive ("I already use Amble"), or with the household's own server. Also the screens for
// when another tab has the database, or the browser won't give Amble storage.
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import ErrorIcon from '~icons/material-symbols/error-outline-rounded';
import { api, ApiError, appUrl, type Member } from '../lib/api.ts';
import { deviceFailure, useHere, type DeviceState } from '../lib/device.ts';
import { refreshStatus } from '../lib/drive-sync.ts';
import { applyUpdate, useUpdateReady } from '../lib/pwa.ts';
import { googleConfigured, resumeAfterGoogle, tokenFromTap } from '../lib/google.ts';
import { useServerReturn } from '../lib/server-sync.ts';
import { ServerForm } from '../components/ServerForm.tsx';
import { joinHousehold } from './SyncSettings.tsx';
import { expressive } from '../lib/motion.ts';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <motion.img
        src={appUrl('/icon.svg')}
        alt=""
        initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={expressive.slowSpatial}
        className="size-24"
      />
      <h1 className="display mt-8 text-[3.5rem] leading-none font-medium">Amble</h1>
      {children}
    </main>
  );
}

export function Welcome() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [server, setServer] = useState(false);

  // Back from signing in on the household's server: the device has its data now.
  useServerReturn('welcome-server', (outcome) => {
    if (outcome.ok) void joined();
    else setError(outcome.error);
  });

  // Sync is on now: the views and the sync loop (which read "off" when the app opened) catch up.
  const joined = () => Promise.all([qc.invalidateQueries(), refreshStatus().catch(() => null)]);

  /** A second device: whatever this Google account syncs comes in, and the device is theirs. */
  const fromDrive = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await tokenFromTap('welcome');
      const { households } = await api<{ households: { id: string }[] }>('/sync/households', { method: 'POST', body: JSON.stringify({ token }) });
      if (households.length) await joinHousehold('welcome');
      else await api('/sync/connect', { method: 'POST', body: JSON.stringify({ token, mode: 'personal' }) });
      await joined();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // Back from Google after "I already use Amble": carry on.
  useEffect(() => {
    const back = resumeAfterGoogle('welcome');
    if (back?.error) setError(back.error);
    else if (back) void fromDrive();
  }, []);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api<{ member: Member }>('/device/start', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      await qc.invalidateQueries();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
      setSaving(false);
    }
  };

  return (
    <Frame>
      <p className="mt-3 text-lg text-on-surface-variant">A calm planner that knows how full your days are.</p>
      <p className="mt-6 text-on-surface-variant">
        Everything stays on this device. Later you can back it up to your Google Drive and share it with your household.
      </p>
      <form onSubmit={start} className="mt-10 flex flex-col gap-3">
        <label className="flex flex-col gap-2">
          <span className="font-medium">What should Amble call you?</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="given-name"
            autoFocus
            maxLength={80}
            placeholder="Your first name"
            className="rounded-2xl bg-surface-high px-4 py-4 text-lg outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
        </label>
        {error && (
          <p role="alert" className="flex gap-2 text-error">
            <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!name.trim() || saving}
          className="mt-2 rounded-full bg-primary px-6 py-4 text-lg font-medium text-on-primary transition-transform active:scale-[0.97] disabled:opacity-40"
        >
          Start
        </button>
        {googleConfigured && (
          <>
            <button
              type="button"
              onClick={() => void fromDrive()}
              disabled={saving}
              className="rounded-full px-6 py-3 font-medium text-primary transition-transform active:scale-[0.97] disabled:opacity-40"
            >
              I already use Amble
            </button>
            <p className="text-center text-sm text-on-surface-variant">Signs in with Google to bring in what you have, or join a household someone shared.</p>
          </>
        )}
        {!server && (
          <button
            type="button"
            onClick={() => setServer(true)}
            disabled={saving}
            className="rounded-full px-6 py-3 font-medium text-primary transition-transform active:scale-[0.97] disabled:opacity-40"
          >
            Use my own server
          </button>
        )}
      </form>
      {server && (
        <div className="mt-3">
          <ServerForm action="welcome-server" onCancel={() => setServer(false)} />
        </div>
      )}
    </Frame>
  );
}

/** Shown instead of the app while the device's database isn't this tab's to use. */
/**
 * A page broke. Says so plainly, with what went wrong (worth passing on), and a way back. A new
 * version waiting is applied first: a page left open across an update is the likeliest cause.
 */
export function PageError({ error }: { error: unknown }) {
  const updateReady = useUpdateReady();
  useEffect(() => {
    console.error(error);
    if (updateReady) applyUpdate();
  }, [error, updateReady]);
  return (
    <Frame>
      <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
        <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">This page ran into a problem.</p>
          <p className="mt-1 text-sm">Your things are fine. Trying again usually sorts it out.</p>
          {error instanceof Error && <p className="mt-2 text-sm break-words opacity-80">{error.message}</p>}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full bg-primary px-6 py-3 font-medium text-on-primary transition-transform active:scale-[0.97]"
        >
          Try again
        </button>
        <a href={appUrl('/')} className="rounded-full px-6 py-3 font-medium text-primary hover:bg-surface-high">
          Back to Today
        </a>
      </div>
    </Frame>
  );
}

/** Amble on this device didn't answer when the app opened. A new version waiting is applied first (main.tsx). */
export function StartFailed({ error }: { error: unknown }) {
  return (
    <Frame>
      <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
        <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Amble couldn't start on this device.</p>
          <p className="mt-1 text-sm">Your things are still here. Trying again usually sorts it out.</p>
          {error instanceof Error && <p className="mt-2 text-sm opacity-80">{error.message}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-6 rounded-full bg-primary px-6 py-3 font-medium text-on-primary transition-transform active:scale-[0.97]"
      >
        Try again
      </button>
    </Frame>
  );
}

export function DeviceBlocked({ state }: { state: DeviceState }) {
  if (state === 'failed') {
    return (
      <Frame>
        <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
          <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Amble couldn't open its storage on this device.</p>
            <p className="mt-1 text-sm">
              A private window, or a browser set not to keep data for sites, can stop it. Try a normal window.
            </p>
            {deviceFailure() && <p className="mt-2 text-sm opacity-80">{deviceFailure()}</p>}
          </div>
        </div>
      </Frame>
    );
  }
  return (
    <Frame>
      <p className="mt-6 text-lg">{state === 'moved' ? 'Amble moved to another tab.' : 'Amble is open in another tab.'}</p>
      <p className="mt-2 text-on-surface-variant">It can be open in one tab at a time on this device.</p>
      <button
        type="button"
        onClick={useHere}
        className="mt-10 rounded-full bg-primary px-6 py-4 text-lg font-medium text-on-primary transition-transform active:scale-[0.97]"
      >
        Use it here
      </button>
    </Frame>
  );
}
