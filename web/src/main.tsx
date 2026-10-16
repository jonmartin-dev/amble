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
import { NavRail } from './components/NavRail.tsx';
import { StatusPill } from './components/StatusPill.tsx';
import { basePath } from './lib/api.ts';
import { readCalendarsWhileOpen } from './lib/calendar.ts';
import { EXPANDED, InPane, isDetail, useMedia } from './lib/layout.ts';
import { refreshViews } from './lib/mutations.ts';
import { CACHE_MAX_AGE_MS, CACHE_VERSION, claimDevice, idbPersister, prefetchForOffline, shouldSave } from './lib/persist.ts';
import { syncPhoneReminders } from './lib/push.ts';
import { applyUpdate, registerServiceWorker, useUpdateReady } from './lib/pwa.ts';
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
import { ADD_TO_LIST, ListPage } from './pages/ListPage.tsx';
import { Notifications } from './pages/Notifications.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { TaskDetail } from './pages/TaskDetail.tsx';
import { Calendar } from './pages/Calendar.tsx';
import { AiSettings } from './pages/AiSettings.tsx';
import { Capacity } from './pages/Capacity.tsx';
import { ConnectionsPage } from './pages/Connections.tsx';
import { GroupsSettings } from './pages/GroupsSettings.tsx';
import { Settings } from './pages/Settings.tsx';
import { DeviceBlocked, StartFailed, Welcome } from './pages/Welcome.tsx';
import { SyncSettings } from './pages/SyncSettings.tsx';
import { startDriveSync, syncSoon } from './lib/drive-sync.ts';
import { takeGoogleReturn } from './lib/google.ts';
import { takeServerReturn } from './lib/server-sync.ts';
import { onDeviceChange, useDeviceState } from './lib/device.ts';
import { native, QUICK_ADD, startPhone, updateTodayWidget } from './lib/native.ts';
import { Stats } from './pages/Stats.tsx';
import { Today } from './pages/Today.tsx';

/** In the Android app: the phone's reminders and home-screen widget follow what changed. */
function phoneChanged() {
  if (!native) return;
  void syncPhoneReminders().catch(() => {});
  void updateTodayWidget().catch(() => {});
}

/** Sends the outbox for as long as the app runs, and says when the server turned a change down. */
function SyncBridge() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  useEffect(
    () =>
      startSync({
        onSent: () => {
          refreshViews(qc);
          // On a device, a change here goes out to Google Drive soon after.
          syncSoon();
          phoneChanged();
        },
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
  // On a device, the worker says when something changed by itself, like a size guess.
  useEffect(
    () =>
      onDeviceChange(() => {
        refreshViews(qc);
        phoneChanged();
      }),
    [qc],
  );
  // With sync on (Google Drive, or the household's server), rounds run while the app is open.
  useEffect(
    () =>
      startDriveSync(() => {
        refreshViews(qc);
        phoneChanged();
      }),
    [qc],
  );
  // In the Android app: the phone gets the coming reminders, and its notifications' buttons act here.
  useEffect(() => {
    phoneChanged();
    return startPhone({
      open: (path) => void router.navigate({ to: path as '/' }),
      resumed: phoneChanged,
      changed: () => {
        refreshViews(qc);
        syncSoon();
        phoneChanged();
      },
    });
  }, [qc]);
  return null;
}

// The four tabs stay built once they've been opened, and are built ahead in the background soon
// after the app starts, so switching tabs only shows a page instead of building it. A hidden page
// keeps its state (a search, the week being looked at) while its effects stop. Memoized, so the
// shell re-rendering on each navigation doesn't render every kept page again.
const TABS: Record<string, ComponentType> = { '/': memo(Today), '/backlog': memo(Backlog), '/calendar': memo(Calendar), '/stats': memo(Stats) };
// Settings, the pages that open from it, and Activity: each has its own back arrow, so the phone's
// toolbar steps aside there.
const SUBPAGES = ['/settings', '/appearance', '/connections', '/household', '/activity'];

function Root() {
  const qc = useQueryClient();
  const session = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const deviceState = useDeviceState();
  // If Amble can't start and a new version is waiting, the new one may well be the fix.
  const updateReady = useUpdateReady();
  const stuck = deviceState === 'failed' || (!session.data && session.isError);
  useEffect(() => {
    if (stuck && updateReady) applyUpdate();
  }, [stuck, updateReady]);
  // The page on screen. The location changes the moment a link is tapped, but the old page stays
  // until the new one is ready; keying on the location would build the old page again in between.
  const shown = useRouterState({ select: (s) => s.matches.at(-1)?.pathname ?? s.location.pathname });
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  // The Android widget's + opens quick add.
  useEffect(() => {
    const add = () => setAdding(true);
    window.addEventListener(QUICK_ADD, add);
    return () => window.removeEventListener(QUICK_ADD, add);
  }, []);
  const memberId = session.data?.member?.id;
  useSyncMemberTheme();

  const tab = shown in TABS ? shown : null;
  // On a wide screen a task or list opens beside the page it came from, which stays as it was.
  const wide = useMedia(EXPANDED);
  const [lastTab, setLastTab] = useState('/');
  useEffect(() => {
    if (tab) setLastTab(tab);
  }, [tab]);
  const split = wide && isDetail(shown);
  const listed = tab ?? (split ? lastTab : null);
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (listed && !kept.has(listed)) setKept(new Set(kept).add(listed));
  }, [listed, kept]);
  // Once the first page is up. React builds hidden pages at low priority, between other work.
  useEffect(() => {
    if (!memberId) return;
    const t = setTimeout(() => setKept(new Set(Object.keys(TABS))), 1500);
    return () => clearTimeout(t);
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
    // Every list and the whole backlog get loaded now, so they open at once.
    void claimDevice(qc, memberId).then(() => prefetchForOffline(qc, get));
  }, [qc, memberId]);
  useEffect(() => (memberId ? readCalendarsWhileOpen(qc) : undefined), [qc, memberId]);

  if (pathname === '/privacy') return <Privacy />;
  if (deviceState !== 'ready' && deviceState !== 'starting') return <DeviceBlocked state={deviceState} />;
  if (session.isPending) return <div className="min-h-dvh" />;
  if (!session.data && session.isError) return <StartFailed error={session.error} />;
  if (!session.data?.member) return <Welcome />;

  // On a list (open on its own or beside a page), + adds to it.
  const onList = pathname.startsWith('/list/');
  const onAdd = () => (onList ? window.dispatchEvent(new Event(ADD_TO_LIST)) : setAdding(true));
  const addLabel = onList ? 'Add to this list' : 'Add a task';
  const subpage = SUBPAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <div className="min-h-dvh" style={{ paddingLeft: 'var(--rail)' }}>
      <NavRail current={listed} settings={pathname.startsWith('/settings')} onAdd={onAdd} label={addLabel} />
      <div className={split ? 'flex items-start' : undefined}>
        <main
          className={
            split
              ? // Its own scroll, so picking one task after another doesn't move the list.
                'sticky top-0 h-dvh w-[min(26rem,44%)] shrink-0 overflow-y-auto overscroll-contain px-4 pb-10 [scrollbar-width:thin]'
              : `mx-auto max-w-xl px-4 medium:max-w-2xl medium:px-6 medium:pb-12 ${subpage ? 'pb-12' : 'pb-36'}`
          }
          style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}
        >
          {/* Each page rises in softly as it shows: a CSS animation, which stays smooth while the page
              is built and plays again whenever a kept tab goes from hidden to shown. */}
          {Object.entries(TABS).map(([path, Page]) =>
            kept.has(path) || path === listed ? (
              <Keep key={path} mode={path === listed ? 'visible' : 'hidden'}>
                <div className="page-in">
                  <Page />
                </div>
              </Keep>
            ) : null,
          )}
          {!listed && (
            <div key={shown} className="page-in">
              <Outlet />
            </div>
          )}
        </main>
        {split && (
          <section
            aria-label="Open beside"
            className="pane min-h-[calc(100dvh-1.5rem)] min-w-0 flex-1 rounded-[2rem]"
            style={{ marginTop: 'max(0.75rem, env(safe-area-inset-top))', marginRight: 'max(0.75rem, env(safe-area-inset-right))' }}
          >
            <InPane.Provider value={true}>
              <div key={shown} className="page-in mx-auto max-w-2xl px-6 pt-5 pb-12">
                <Outlet />
              </div>
            </InPane.Provider>
          </section>
        )}
      </div>
      <StatusPill />
      <FloatingToolbar onAdd={onAdd} label={addLabel} away={subpage} />
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
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/ai', component: AiSettings }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/calendars', component: CalendarsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/notifications', component: Notifications }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings/sync', component: SyncSettings }),
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
  createRoute({ getParentRoute: () => rootRoute, path: '/privacy', component: Privacy }),
]);

// Back from Google's sign-in (Drive sync): keep the token and restore the address before the
// router reads it.
takeGoogleReturn();
// Back from signing in on the household's server, the same way.
takeServerReturn();

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
    // Kept as long as the saved copy, so the app opens at once. The data is right here on the
    // device, so nothing waits for a connection.
    queries: { retry: 1, refetchOnWindowFocus: true, gcTime: CACHE_MAX_AGE_MS, networkMode: 'always' },
    mutations: { networkMode: 'always' },
  },
});
// The API is on this device, so it's always reachable.
onlineManager.setOnline(true);

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

// The page (or, beside an open task, the list) has scrolled: the strip under a phone's status bar
// fades out over what's beneath it (styles.css). Other scrollers, like a sheet's, don't count.
document.addEventListener(
  'scroll',
  (e) => {
    const scroller = e.target === document ? document.scrollingElement : e.target instanceof HTMLElement && e.target.tagName === 'MAIN' ? e.target : null;
    if (scroller) document.documentElement.toggleAttribute('data-scrolled', scroller.scrollTop > 0);
  },
  { capture: true, passive: true },
);
