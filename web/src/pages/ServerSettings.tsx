// Settings → Your server, on a device that syncs with the household's own server: what its page
// has (server/settings.ts), here in the app. Codes to add a phone or computer, Claude and ChatGPT, the household's AI
// model, and bringing a household over from Google Drive. Connecting Drive needs Google in a
// browser, so that one step opens the server's page.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Dns from '~icons/material-symbols/dns-outline';
import Forum from '~icons/material-symbols/forum-outline-rounded';
import Neurology from '~icons/material-symbols/neurology-outline-rounded';
import OpenInNew from '~icons/material-symbols/open-in-new-rounded';
import { JoinCode } from '../components/JoinCode.tsx';
import { ListGroup, SectionTitle, SubpageHeader } from '../components/ui.tsx';
import { api, ApiError, type ServerSettings as Settings } from '../lib/api.ts';
import { useDriveSync } from '../lib/drive-sync.ts';
import { useServerSettings } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

const quiet = 'rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high disabled:opacity-40';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function ServerSettingsPage() {
  const status = useDriveSync().status;
  const onServer = status?.target?.kind === 'server';
  const server = useServerSettings(onServer);

  if (!onServer) {
    return (
      <>
        <SubpageHeader title="Your server" />
        <p className="px-1 text-on-surface-variant">This device doesn't sync with a server. Set that up in Settings, Sync and backup.</p>
      </>
    );
  }
  return (
    <>
      <SubpageHeader title="Your server" />
      {server.isPending ? (
        <p className="px-1 text-on-surface-variant">Asking your server…</p>
      ) : server.isError ? (
        <p className="rounded-3xl bg-warm-container p-4 text-sm text-on-warm-container">
          Couldn’t reach your server just now{server.error instanceof Error ? `: ${server.error.message}` : '.'}
        </p>
      ) : (
        <Loaded data={server.data} />
      )}
    </>
  );
}

function Loaded({ data }: { data: Settings }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const host = new URL(data.url).host;
  const refresh = () => qc.invalidateQueries({ queryKey: ['server-settings'] });
  const failed = (e: unknown) => snack({ message: e instanceof ApiError || e instanceof Error ? e.message : 'That didn’t work.' });

  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/sync/server/settings/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      snack({ message: 'Disconnected.' });
      void refresh();
    },
    onError: failed,
  });
  const drive = useMutation({
    mutationFn: (action: 'run' | 'stop') => api(`/sync/server/settings/drive/${action}`, { method: 'POST', body: '{}' }),
    onSuccess: (_, action) => {
      snack({ message: action === 'stop' ? 'Your server stopped syncing with Google Drive.' : 'Synced.' });
      void refresh();
    },
    onError: failed,
  });

  return (
    <>
      <section className="rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <Dns className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium break-all">{host}</h2>
        </div>
        <p className="mt-2">
          Keeps everyone's devices in step, photos and files on tasks included. You're signed in there as {data.me.name} ({data.me.email})
          {data.me.role === 'admin' ? ', an admin' : ''}.
        </p>
      </section>

      <SectionTitle>Add a phone or computer</SectionTitle>
      <p className="px-1 text-on-surface-variant">
        Make a code here and use it on the new one: your own other phone or computer, or someone new to the household. A code signs into a browser too,
        like the page Claude or ChatGPT opens when you connect it.
      </p>
      <div className="mt-3">
        <JoinCode url={data.url} admin={data.me.role === 'admin'} />
      </div>

      <SectionTitle>Claude and ChatGPT</SectionTitle>
      <ListGroup
        rows={[
          { icon: <Forum className="size-6" />, title: 'Connect one', subtitle: 'Plan from Claude or ChatGPT, as you', to: '/connections' },
          ...data.connections.map((g) => ({
            title: g.clientName,
            subtitle: `Connected ${when(g.createdAt)} · last used ${when(g.lastUsedAt)}`,
            trailing: (
              <button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate(g.id)} className={quiet}>
                Disconnect
              </button>
            ),
          })),
        ]}
      />

      <SectionTitle>AI</SectionTitle>
      <ListGroup
        rows={[
          {
            icon: <Neurology className="size-6" />,
            title: 'The household’s model',
            subtitle: data.ai.available ? `${data.ai.modelName}, from ${data.ai.providerName}` : 'None yet',
            to: '/settings/ai',
          },
        ]}
      />

      {data.drive && (
        <>
          <SectionTitle>Coming from Google Drive</SectionTitle>
          {data.drive.on ? (
            <>
              <ListGroup
                rows={[
                  {
                    title: data.drive.name ?? 'Google Drive',
                    subtitle: data.drive.error ?? `As ${data.drive.account ?? 'Google'} · last synced ${when(data.drive.syncedAt)}`,
                    trailing: (
                      <button type="button" disabled={drive.isPending} onClick={() => drive.mutate('run')} className={quiet}>
                        Sync now
                      </button>
                    ),
                  },
                ]}
              />
              <p className="mt-2 px-1 text-sm text-on-surface-variant">
                Your server keeps in step with the household's file in Drive, so devices still syncing there see the same things. Each is offered a move here
                in Settings, Sync and backup. Once they've all moved, stop it.
              </p>
              <button
                type="button"
                disabled={drive.isPending}
                onClick={() => {
                  if (confirm('Stop syncing your server with Google Drive? Its data stays, and so does the file in Drive.')) drive.mutate('stop');
                }}
                className={`mt-2 ${quiet}`}
              >
                Stop syncing with Drive
              </button>
            </>
          ) : (
            <>
              <p className="px-1 text-on-surface-variant">
                If your household already keeps Amble in Google Drive, your server can bring it all over. Connecting asks Google in a browser, on the
                server's page.
              </p>
              <a href={`${data.url}/server`} target="_blank" rel="noreferrer" className={`mt-2 inline-flex items-center gap-1 ${quiet}`}>
                Open the server's page
                <OpenInNew className="size-4" aria-hidden />
              </a>
            </>
          )}
        </>
      )}
    </>
  );
}
