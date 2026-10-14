import '@fontsource-variable/google-sans-flex/rond.css';
import './styles.css';
import { onlineManager, QueryClient, useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { Activity as Keep, memo, StrictMode, useEffect, useState, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { AddSheet } from './components/AddSheet.tsx';
import { FloatingToolbar } from './components/FloatingToolbar.tsx';
import { StatusPill } from './components/StatusPill.tsx';
import { basePath } from './lib/api.ts';
import { syncCalendarsWhileOpen } from './lib/calendar.ts';
import { refreshViews } from './lib/mutations.ts';
import { CACHE_MAX_AGE_MS, CACHE_VERSION, claimDevice, idbPersister, prefetchForOffline, shouldSave } from './lib/persist.ts';
import { refreshPush } from './lib/push.ts';
import { registerServiceWorker } from './lib/pwa.ts';
import { get, useSession } from './lib/queries.ts';
import { SnackbarProvider, useSnackbar } from './lib/snackbar.tsx';
import { startSync } from './lib/sync.ts';
import { applyTheme, loadLocalTheme } from './lib/theme.ts';
import { useSyncMemberTheme } from './lib/useTheme.ts';
import { Activity } from './pages/Activity.tsx';
import { Appearance } from './pages/Appearance.tsx';
import { Backlog } from './pages/Backlog.tsx';
import { Briefing } from './pages/Briefing.tsx';
import { CalendarsPage } from './pages/Calendars.tsx';
import { Household } from './pages/Household.tsx';
import { ListPage } from './pages/ListPage.tsx';
import { Notifications } from './pages/Notifications.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { TaskDetail } from './pages/TaskDetail.tsx';
import { Calendar } from './pages/Calendar.tsx';
import { Capacity } from './pages/Capacity.tsx';
import { Connect } from './pages/Connect.tsx';
import { ConnectionsPage } from './pages/Connections.tsx';
import { GroupsSettings } from './pages/GroupsSettings.tsx';
import { Settings } from './pages/Settings.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Stats } from './pages/Stats.tsx';
import { Today } from './pages/Today.tsx';

/** Sends the outbox for as long as the app runs, and says when the server turned a change down. */
function SyncBridge() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  useEffect(
    () =>
      startSync({
        onSent: () => refreshViews(qc),
        onFailed: (failures) => {
          const [first] = failures;
          snack({
            message:
              failures.length === 1
                ? `Couldn't save "${first!.label}": ${first!.message}`
                : `${failures.length} changes couldn't be saved. The first: ${first!.message}`,
          });
          refreshViews(qc);
        },
        onSignedOut: () => void qc.invalidateQueries({ queryKey: ['session'] }),
      }),
    [qc, snack],
  );
  return null;
}

function Offline() {
  return (
    <div className="grid min-h-dvh place-items-center px-8 text-center">
      <div>
        <p className="display text-2xl font-medium">You're offline</p>
        <p className="mt-2 text-on-surface-variant">Almanac needs a connection the first time it opens on this device. After that it works offline too.</p>
      </div>
    </div>
  );
}

// The four tabs stay built once they've been opened, and are built ahead in the background soon
// after the app starts, so switching tabs only shows a page instead of building it. A hidden page
// keeps its state (a search, the week being looked at) while its effects stop. Memoized, so the
// shell re-rendering on each navigation doesn't render every kept page again.
const TABS: Record<string, ComponentType> = { '/': memo(Today), '/backlog': memo(Backlog), '/calendar': memo(Calendar), '/stats': memo(Stats) };

function Root() {
  const qc = useQueryClient();
  const session = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The page on screen. The location changes the moment a link is tapped, but the old page stays
  // until the new one is ready; keying on the location would build the old page again in between.
  const shown = useRouterState({ select: (s) => s.matches.at(-1)?.pathname ?? s.location.pathname });
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const memberId = session.data?.member?.id;
  useSyncMemberTheme();

  const tab = shown in TABS ? shown : null;
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (tab && !kept.has(tab)) setKept(new Set(kept).add(tab));
  }, [tab, kept]);
  // Once the first page is up. React builds hidden pages at low priority, between other work.
  useEffect(() => {
    if (!memberId) return;
    const t = setTimeout(() => setKept(new Set(Object.keys(TABS))), 1500);
    return () => clearTimeout(t);
  }, [memberId]);

  // Notifications follow whoever is signed in here, so tell the server about this device again.
  useEffect(() => {
    if (memberId && navigator.onLine) void refreshPush().catch(() => {});
  }, [memberId]);
  // Tapping a reminder while the app is open brings it to that task.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; path?: string } | null;
      if (data?.type === 'open' && data.path) void navigate({ to: data.path as '/' });
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [navigate]);

  useEffect(() => {
    if (!memberId) return;
    // Whatever should open offline gets loaded now, while there's a connection.
    void claimDevice(qc, memberId).then(() => navigator.onLine && prefetchForOffline(qc, get));
  }, [qc, memberId]);
  useEffect(() => (memberId ? syncCalendarsWhileOpen(qc) : undefined), [qc, memberId]);

  if (pathname === '/privacy') return <Privacy />;
  if (session.isPending) return <div className="min-h-dvh" />;
  if (!session.data && session.isError) return <Offline />;
  if (!session.data?.member || pathname === '/signin') return <SignIn />;
  // The consent page stands alone, without the app's toolbar.
  if (pathname.startsWith('/connect/')) return <Outlet />;

  return (
    <div className="min-h-dvh">
      <main className="mx-auto max-w-xl px-4 pt-6 pb-36" style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}>
        {/* Each page rises in softly as it shows: a CSS animation, which stays smooth while the page
            is built and plays again whenever a kept tab goes from hidden to shown. */}
        {Object.entries(TABS).map(([path, Page]) =>
          kept.has(path) || path === tab ? (
            <Keep key={path} mode={path === tab ? 'visible' : 'hidden'}>
              <div className="page-in">
                <Page />
              </div>
            </Keep>
          ) : null,
        )}
        {!tab && (
          <div key={shown} className="page-in">
            <Outlet />
          </div>
        )}
      </main>
      <StatusPill />
      <FloatingToolbar onAdd={() => setAdding(true)} />
      <AddSheet open={adding} onClose={() => setAdding(false)} plannedByDefault={pathname === '/'} />
    </div>
  );
}

const rootRoute = createRootRoute({ component: Root });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Today }),
  createRoute({ getParentRoute: () => rootRoute, path: '/backlog', component: Backlog }),
  createRoute({ getParentRoute: () => rootRoute, path: '/calendar', component: Calendar }),
  createRoute({ getParentRoute: () => rootRoute, path: '/stats', component: Stats }),
  createRoute({ getParentRoute: () => rootRoute, path: '/appearance', component: Appearance }),
  createRoute({ getParentRoute: () => rootRoute, path: '/connections', component: ConnectionsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/household', component: Household }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: Settings }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/groups', component: GroupsSettings }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/capacity', component: Capacity }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/calendars', component: CalendarsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/notifications', component: Notifications }),
  createRoute({ getParentRoute: () => rootRoute, path: '/briefing', component: Briefing }),
  createRoute({ getParentRoute: () => rootRoute, path: '/activity', component: Activity }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/task/$taskId',
    component: function TaskRoute() {
      const { taskId } = useParams({ strict: false });
      return <TaskDetail key={taskId} taskId={taskId ?? ''} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/list/$groupId',
    component: function ListRoute() {
      const { groupId } = useParams({ strict: false });
      return <ListPage key={groupId} groupId={groupId ?? ''} />;
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/connect/$requestId',
    component: function ConnectRoute() {
      const { requestId } = useParams({ strict: false });
      return <Connect requestId={requestId ?? ''} />;
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/signin', component: SignIn }),
  createRoute({ getParentRoute: () => rootRoute, path: '/privacy', component: Privacy }),
]);

// Apply the saved theme before the first paint so there's no flash of the default colors.
applyTheme(loadLocalTheme());

// No View Transitions between screens: on a phone the crossfade's snapshots held up every switch,
// and the page's own rise-in already marks the change.
const router = createRouter({
  routeTree,
  basepath: basePath || '/',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    // Kept as long as the saved copy on the device, so what was loaded still opens offline.
    queries: { retry: 1, refetchOnWindowFocus: true, gcTime: CACHE_MAX_AGE_MS },
  },
});
// TanStack Query assumes it starts online; tell it the truth so offline reads don't spin.
onlineManager.setOnline(navigator.onLine);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: idbPersister(),
        maxAge: CACHE_MAX_AGE_MS,
        buster: CACHE_VERSION,
        dehydrateOptions: { shouldDehydrateQuery: shouldSave },
      }}
      // The saved copy shows at once; everything on screen still refreshes from the server.
      onSuccess={() => void queryClient.invalidateQueries()}
    >
      <MotionConfig reducedMotion="user">
        <SnackbarProvider>
          <SyncBridge />
          <RouterProvider router={router} />
        </SnackbarProvider>
      </MotionConfig>
    </PersistQueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
