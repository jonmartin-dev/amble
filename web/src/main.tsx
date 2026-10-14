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
import { MotionConfig } from 'motion/react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AddSheet } from './components/AddSheet.tsx';
import { FloatingToolbar } from './components/FloatingToolbar.tsx';
import { appUrl, basePath } from './lib/api.ts';
import { useSession } from './lib/queries.ts';
import { applyTheme, loadLocalTheme } from './lib/theme.ts';
import { useSyncMemberTheme } from './lib/useTheme.ts';
import { Appearance } from './pages/Appearance.tsx';
import { Backlog } from './pages/Backlog.tsx';
import { Privacy } from './pages/Privacy.tsx';
import { Calendar } from './pages/Calendar.tsx';
import { Connect } from './pages/Connect.tsx';
import { ConnectionsPage } from './pages/Connections.tsx';
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
        <Outlet />
      </main>
      <FloatingToolbar onAdd={() => setAdding(true)} />
      <AddSheet open={adding} onClose={() => setAdding(false)} />
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
        <RouterProvider router={router} />
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register(appUrl('/sw.js'), { scope: `${basePath}/` });
}
