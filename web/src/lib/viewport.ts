import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

interface View {
  /** Height of the part of the screen that's visible, above the keyboard. */
  height: number;
  /** How much of the bottom of the layout the on-screen keyboard covers. */
  keyboard: number;
}

function read(): View {
  const vv = window.visualViewport;
  if (!vv) return { height: window.innerHeight, keyboard: 0 };
  return { height: vv.height, keyboard: Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) };
}

/**
 * Phones open the keyboard over the page without resizing it, so anything pinned to the bottom
 * ends up underneath. This follows the visual viewport so a bottom sheet can sit on the keyboard.
 */
export function useVisualViewport(active: boolean): View {
  const [view, setView] = useState(read);
  // Listen from the moment the sheet is on the page, so a keyboard that opens straight away isn't missed.
  useLayoutEffect(() => {
    if (!active) return;
    const vv = window.visualViewport;
    const update = () => setView(read());
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [active]);
  return view;
}

let locks = 0;

/** Stops the page behind a sheet from scrolling (and rubber-banding on iOS) while it's open. */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (locks++ === 0) root.style.overflow = 'hidden';
    return () => {
      if (--locks === 0) root.style.overflow = '';
    };
  }, [active]);
}

/**
 * The phone's back button (or back swipe) closes an open sheet instead of leaving the page. The
 * sheet adds a history entry when it opens and removes it when closed some other way.
 */
export function useBackToClose(open: boolean, onClose: () => void) {
  const id = useId();
  const openRef = useRef(open);
  const closeRef = useRef(onClose);
  openRef.current = open;
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ ...window.history.state, __sheet: id }, '');
    const onPop = () => {
      if (window.history.state?.__sheet !== id) closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed by a tap rather than Back: take our entry off again, unless something else
      // (a navigation, another sheet) has already moved on from it.
      setTimeout(() => {
        if (!openRef.current && window.history.state?.__sheet === id) window.history.back();
      }, 0);
    };
  }, [open, id]);
}
