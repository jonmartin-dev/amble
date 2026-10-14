import '@fontsource-variable/google-sans-flex/rond.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  useRouterState,
} from '@tanstack/react-router';
import { motion, MotionConfig } from 'motion/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddSheet } from './components/AddSheet.tsx';
import { FloatingToolbar } from './components/FloatingToolbar.tsx';
import { appUrl, basePath } from './lib/api.ts';
import { expressive } from './lib/motion.ts';
import { useSession } from './lib/queries.ts';
import { SnackbarProvider } from './lib/snackbar.tsx';
import { applyTheme, loadLocalTheme } from './lib/theme.ts';
import { useSyncMemberTheme } from './lib/useTheme.ts';
import { Activity } from './pages/Activity.tsx';
import { Appearance } from './pages/Appearance.tsx';
import { Backlog } from './pages/Backlog.tsx';
import { Household } from './pages/Household.tsx';
import { ListPage } from './pages/ListPage.tsx';
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

function Root() {
  const session = useSession();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [adding, setAdding] = useState(false);
  useSyncMemberTheme();

  if (pathname === '/privacy') return <Privacy />;
  if (session.isPending) return <div className="min-h-dvh" />;
  if (!session.data?.member || pathname === '/signin') return <SignIn />;
  // The consent page stands alone, without the app's toolbar.
  if (pathname.startsWith('/connect/')) return <Outlet />;

  return (
    <div className="min-h-dvh">
      <main className="mx-auto max-w-xl px-4 pt-6 pb-36" style={{ paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }}>
        {/* Each page rises in softly; the springs settle quickly so it never feels slow. */}
        <motion.div key={pathname} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={expressive.defaultSpatial}>
          <Outlet />
        </motion.div>
      </main>
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

// Same-document View Transitions crossfade between screens where the browser supports them.
const router = createRouter({ routeTree, basepath: basePath || '/', defaultViewTransition: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <SnackbarProvider>
          <RouterProvider router={router} />
        </SnackbarProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(appUrl('/sw.js'), { scope: `${basePath}/` });
}
