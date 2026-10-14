// How the app fits the screen it's on, after Material's window sizes. A phone (and a Fold's cover
// screen) gets the floating toolbar. From medium, 600dp (a big phone on its side, a Fold opened,
// a small tablet), a navigation rail runs down the left. From expanded, 840dp (a Fold opened wide,
// tablets), a task or list opens beside the page it came from instead of in place of it.
import { createContext, useContext, useSyncExternalStore } from 'react';

export const MEDIUM = '(min-width: 37.5rem)';
export const EXPANDED = '(min-width: 52.5rem)';

/** Whether a media query matches, kept current as the window changes (turning, unfolding). */
export function useMedia(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => matchMedia(query).matches,
  );
}

/** Pages that open beside the one they came from on a wide screen: a task, a list. */
export function isDetail(pathname: string) {
  return pathname.startsWith('/task/') || pathname.startsWith('/list/');
}

/**
 * Whether opening something now should take the place of the step Back would undo, rather than
 * stack another: on a wide screen, picking one task after another, or a task from a sheet (which
 * gets out of the way as the task opens beside the page).
 */
export function swapsDetail(pathname: string) {
  return matchMedia(EXPANDED).matches && (isDetail(pathname) || window.history.state?.__sheet != null);
}

/** True inside the pane beside a page, where a page's back arrow closes the pane instead. */
export const InPane = createContext(false);
export const useInPane = () => useContext(InPane);
