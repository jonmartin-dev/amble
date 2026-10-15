// Settings → Sync and backup, on a device with no server: keeping a copy in the person's Google
// Drive, making that a household others can join, and joining one someone shared.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import CloudSync from '~icons/material-symbols/cloud-sync-outline-rounded';
import Groups from '~icons/material-symbols/groups-outline-rounded';
import PersonAdd from '~icons/material-symbols/person-add-outline-rounded';
import Warning from '~icons/material-symbols/warning-outline-rounded';
import { ListGroup, SectionTitle, SubpageHeader } from '../components/ui.tsx';
import { api, ApiError, appUrl } from '../lib/api.ts';
import { onDevice } from '../lib/device.ts';
import { native } from '../lib/native.ts';
import { refreshStatus, syncNow, useDriveSync, type DriveSyncStatus } from '../lib/drive-sync.ts';
import { googleConfigured, pickHouseholdFile, resumeAfterGoogle, tokenFromTap } from '../lib/google.ts';
import { refreshViews } from '../lib/mutations.ts';
import { useMe } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

interface Person {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

const button = 'rounded-full bg-primary px-5 py-3 font-medium text-on-primary transition-opacity disabled:opacity-40';
const quiet = 'rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high disabled:opacity-40';

function syncedLabel(s: DriveSyncStatus, syncing: boolean, needsGoogle: boolean) {
  if (syncing) return 'Syncing…';
  if (needsGoogle) return 'Paused until you sign in to Google again';
  if (s.error) return s.error;
  if (s.waiting) return 'Changes here are waiting to sync';
  if (!s.syncedAt) return 'Not synced yet';
  const minutes = Math.round((Date.now() - new Date(s.syncedAt).getTime()) / 60_000);
  if (minutes < 1) return 'Up to date';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return minutes < 60 ? `Synced ${rtf.format(-minutes, 'minute')}` : `Synced ${rtf.format(-Math.round(minutes / 60), 'hour')}`;
}

/** Joins a household someone shared: Google's picker, then the file comes in. */
export async function joinHousehold(action: string, email?: string) {
  const token = await tokenFromTap(action, email);
  // Files this account made or picked before show up without the picker.
  const { households } = await api<{ households: { id: string; name: string }[] }>('/sync/households', { method: 'POST', body: JSON.stringify({ token }) });
  const fileId = households.length === 1 ? households[0]!.id : await pickHouseholdFile(token, email);
  if (!fileId) return null;
  return api<DriveSyncStatus>('/sync/connect', { method: 'POST', body: JSON.stringify({ token, mode: 'join', fileId }) });
}

export function SyncSettings() {
  return onDevice ? <DeviceSync /> : <ServerSync />;
}

interface ServerStatus extends DriveSyncStatus {
  mode: 'server';
  /** The server has a Google client to connect with. */
  enabled: boolean;
  /** The Google account the server syncs as, once an admin connected one. */
  google: string | null;
}

/** On a server: an admin connects it to Google Drive, so it keeps in step with the household's devices. */
function ServerSync() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const me = useMe();
  const admin = me?.role === 'admin';
  const { data: status } = useQuery({ queryKey: ['sync'], queryFn: () => api<ServerStatus>('/sync') });
  const { data: households } = useQuery({
    queryKey: ['sync', 'households'],
    queryFn: () => api<{ households: { id: string; name: string; owner: string | null }[] }>('/sync/households', { method: 'POST', body: '{}' }),
    enabled: Boolean(admin && status?.google && !status.on),
    select: (d) => d.households,
  });
  const [busy, setBusy] = useState(false);
  const problem = new URLSearchParams(window.location.search).get('error');

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      refreshViews(qc);
    } catch (e) {
      snack({ message: (e as Error).message });
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['sync'] });
    }
  };
  const connect = (body: object) => run(() => api('/sync/connect', { method: 'POST', body: JSON.stringify(body) }));
  const stop = () => {
    if (confirm('Stop syncing this server? Its data stays, and so does the file in Google Drive.')) void run(() => api('/sync', { method: 'DELETE' }));
  };

  return (
    <>
      <SubpageHeader title="Sync" />
      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <CloudSync className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">Keep this server in step with your devices</h2>
        </div>
        <p className="mt-2">
          A household that keeps Amble in Google Drive can have this server as one more copy. Then the server's own app, and Claude or
          ChatGPT through the connector, see and change the same tasks and lists as everyone's phones.
        </p>
      </section>

      {problem && (
        <p role="alert" className="mt-4 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
          <Warning className="size-6 shrink-0" aria-hidden />
          {problem === 'off' ? 'Only an admin can connect Google Drive, and the server needs a Google sign-in client.' : problem}
        </p>
      )}

      {status && !status.enabled ? (
        <p className="mt-6 flex gap-3 rounded-3xl bg-surface-low p-5 text-on-surface-variant">
          <Warning className="size-6 shrink-0" aria-hidden />
          Sync needs a Google sign-in client on this server, with the Google Drive API turned on.
        </p>
      ) : status?.on ? (
        <>
          <SectionTitle>Syncing</SectionTitle>
          <ListGroup
            rows={[
              {
                icon: <CloudSync className="size-6" />,
                title: status.target?.name ?? 'Google Drive',
                subtitle: `${status.google ?? 'Google Drive'} · ${syncedLabel(status, busy, false)}`,
                trailing: admin ? (
                  <button type="button" disabled={busy} onClick={() => void run(() => api('/sync/run', { method: 'POST', body: '{}' }))} className={quiet}>
                    Sync now
                  </button>
                ) : undefined,
              },
            ]}
          />
          {admin && (
            <button type="button" disabled={busy} onClick={stop} className={`mt-4 ${quiet}`}>
              Stop syncing
            </button>
          )}
        </>
      ) : !admin ? (
        <p className="mt-6 px-1 text-on-surface-variant">An admin can connect this server to Google Drive.</p>
      ) : !status?.google ? (
        <div className="mt-6 flex flex-col items-start gap-3">
          <button type="button" onClick={() => window.location.assign(appUrl('/auth/drive'))} className={button}>
            Connect Google Drive
          </button>
          <p className="px-1 text-sm text-on-surface-variant">
            Google asks whether Amble can keep its files in your Drive. The server keeps that access, to sync while nobody's using it.
          </p>
        </div>
      ) : (
        <>
          <SectionTitle>Join a household</SectionTitle>
          {households?.length ? (
            <ListGroup
              rows={households.map((h) => ({
                icon: <Groups className="size-6" />,
                title: h.name,
                subtitle: h.owner ? `Kept by ${h.owner}` : undefined,
                trailing: (
                  <button type="button" disabled={busy} onClick={() => void connect({ mode: 'join', fileId: h.id })} className={quiet}>
                    Join
                  </button>
                ),
              }))}
            />
          ) : (
            <p className="px-1 text-on-surface-variant">
              {households
                ? `No household files that ${status.google} can open yet. Join or make one in Amble on a device with this account, or start one here.`
                : 'Looking…'}
            </p>
          )}
          <SectionTitle>Or start one</SectionTitle>
          <button type="button" disabled={busy} onClick={() => void connect({ mode: 'create', name: `${me?.name ?? 'Our'}'s Amble household` })} className={button}>
            Make a household from this server
          </button>
          <p className="mt-2 px-1 text-sm text-on-surface-variant">Everything on this server goes into a new file in Google Drive, for devices to join.</p>
        </>
      )}
    </>
  );
}

function DeviceSync() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const me = useMe();
  const { status, syncing, needsGoogle } = useDriveSync();
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [adding, setAdding] = useState<{ email: string; name: string } | null>(null);

  useEffect(() => {
    void refreshStatus().catch(() => {});
  }, []);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refreshStatus();
      refreshViews(qc);
    } catch (e) {
      snack({ message: e instanceof ApiError || e instanceof Error ? e.message : `${label} didn't work.` });
    } finally {
      setBusy(false);
    }
  };

  const connect = (mode: 'personal' | 'create') =>
    run('Syncing', async () => {
      const token = await tokenFromTap(`connect:${mode}`, status?.account?.email);
      const body = mode === 'create' ? { token, mode, name: `${me?.name ?? 'Our'}'s Amble household` } : { token, mode };
      await api('/sync/connect', { method: 'POST', body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: ['session'] });
    });

  const join = () =>
    run('Joining', async () => {
      if (await joinHousehold('join', status?.account?.email)) await qc.invalidateQueries({ queryKey: ['session'] });
    });

  const loadPeople = () =>
    run('Loading', async () => {
      const token = await tokenFromTap('people', status?.account?.email);
      setPeople((await api<{ people: Person[] }>('/sync/people', { method: 'POST', body: JSON.stringify({ token }) })).people);
    });

  const share = (email: string, name: string) =>
    run('Sharing', async () => {
      const token = await tokenFromTap('share', status?.account?.email);
      await api('/sync/share', { method: 'POST', body: JSON.stringify({ token, email, name }) });
      snack({ message: `Shared with ${email}. Google emailed them a link.` });
      setAdding(null);
      setPeople(null);
      void syncNow();
    });

  // Back from Google: carry on with what was tapped.
  useEffect(() => {
    for (const [action, go] of [
      ['connect:personal', () => connect('personal')],
      ['connect:create', () => connect('create')],
      ['join', join],
      ['people', loadPeople],
    ] as const) {
      const back = resumeAfterGoogle(action);
      if (back?.error) snack({ message: back.error });
      else if (back) void go();
    }
    // Once, when the page opens.
  }, []);

  const stop = () => {
    if (!confirm('Stop syncing on this device? What’s here stays here, and the copy in Google Drive stays for your other devices.')) return;
    void run('Stopping', () => api('/sync', { method: 'DELETE' }));
  };

  if (!googleConfigured) {
    return (
      <>
        <SubpageHeader title="Sync and backup" />
        <p className="mt-4 flex gap-3 rounded-3xl bg-surface-low p-5 text-on-surface-variant">
          <Warning className="size-6 shrink-0" aria-hidden />
          This copy of Amble wasn't built with a Google sign-in client, so it can't sync through Google Drive.
        </p>
      </>
    );
  }

  const household = status?.target?.kind === 'household';
  const owner = household && status?.target?.owner === status?.account?.email;

  return (
    <>
      <SubpageHeader title="Sync and backup" />

      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <CloudSync className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">Keep it in your Google Drive</h2>
        </div>
        <p className="mt-2">
          Amble keeps a copy in your own Google Drive and brings your other devices and your household in step with it. It can only see
          the files it makes there, and nothing goes anywhere else.
        </p>
      </section>

      {!status?.on ? (
        <div className="mt-6 flex flex-col items-start gap-3">
          <button type="button" disabled={busy} onClick={() => void connect('personal')} className={button}>
            Sync with Google Drive
          </button>
          <button type="button" disabled={busy} onClick={() => void join()} className={quiet}>
            Join a household someone shared with you
          </button>
          <p className="px-1 text-sm text-on-surface-variant">Google asks once whether Amble can keep its files in your Drive.</p>
        </div>
      ) : (
        <>
          <SectionTitle>This device</SectionTitle>
          <ListGroup
            rows={[
              {
                icon: <CloudSync className="size-6" />,
                title: status.account?.email ?? 'Google Drive',
                subtitle: syncedLabel(status, syncing, needsGoogle),
                trailing: (
                  <button type="button" disabled={busy || syncing} onClick={() => void run('Syncing', () => syncNow({ tap: true }))} className={quiet}>
                    Sync now
                  </button>
                ),
              },
            ]}
          />
          <p className="mt-2 px-1 text-sm text-on-surface-variant">
            {native
              ? 'It syncs when Amble opens, every minute while it’s open, and soon after each change.'
              : 'While Amble is open it syncs every minute. Google lets a browser keep access for about an hour, so now and then it asks you to tap to carry on.'}
          </p>

          <SectionTitle>Household</SectionTitle>
          {!household ? (
            <div className="flex flex-col items-start gap-3">
              <p className="px-1 text-on-surface-variant">Share Amble with the people you live with: groups, lists and tasks you can hand each other.</p>
              <button type="button" disabled={busy} onClick={() => void connect('create')} className={button}>
                <span className="flex items-center gap-2">
                  <Groups className="size-5" aria-hidden />
                  Make this a household
                </span>
              </button>
              <button type="button" disabled={busy} onClick={() => void join()} className={quiet}>
                Join a household someone shared with you instead
              </button>
            </div>
          ) : (
            <>
              <p className="px-1 text-on-surface-variant">
                Synced through “{status.target?.name}”{owner ? ' in your Drive' : status.target?.owner ? `, shared by ${status.target.owner}` : ''}.
              </p>
              {people ? (
                <ListGroup
                  rows={people.map((p) => ({
                    icon: <Groups className="size-6" />,
                    title: p.name || p.email || 'Someone',
                    subtitle: p.role === 'owner' ? `${p.email} · keeps the file` : (p.email ?? undefined),
                  }))}
                />
              ) : (
                <button type="button" disabled={busy} onClick={() => void loadPeople()} className={quiet}>
                  Show who it's shared with
                </button>
              )}
              {owner &&
                (adding ? (
                  <form
                    className="mt-3 flex flex-col gap-2 rounded-3xl bg-surface-low p-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (adding.email.trim()) void share(adding.email.trim(), adding.name.trim());
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
                    <p className="px-1 text-sm text-on-surface-variant">
                      Google emails them a link. In Amble they choose “Join a household” and pick the file once.
                    </p>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setAdding(null)} className="rounded-full px-4 py-2 text-sm font-medium">
                        Cancel
                      </button>
                      <button type="submit" disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-40">
                        Share
                      </button>
                    </div>
                  </form>
                ) : (
                  <button type="button" onClick={() => setAdding({ email: '', name: '' })} className={`mt-2 flex items-center gap-2 ${quiet}`}>
                    <PersonAdd className="size-5" aria-hidden />
                    Add someone
                  </button>
                ))}
              <p className="mt-3 px-1 text-sm text-on-surface-variant">
                Everyone in the household has the whole file in their Drive. Private lists stay out of their view in Amble, but the file
                itself holds them. Photos and files on tasks stay on the devices of whoever added them.
              </p>
            </>
          )}

          <SectionTitle>Stop</SectionTitle>
          <button type="button" disabled={busy} onClick={stop} className={quiet}>
            Stop syncing on this device
          </button>
        </>
      )}
    </>
  );
}
