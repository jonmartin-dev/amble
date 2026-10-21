import { Capacitor } from '@capacitor/core';
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

/**
 * In the Android app the keyboard rises over the page, and as it starts to move the app says where
 * it's going and how it'll get there (MainActivity): how much of the bottom of the page it'll
 * cover, and its own duration and curve. Something riding on it then arrives with the keyboard,
 * not a few frames behind as it would following the visible part of the page.
 */
interface KeyboardMove {
  to: number;
  ms: number;
  easing: string;
}
export const keyboardFromApp = Capacitor.getPlatform() === 'android';
let keyboardAt: KeyboardMove = { to: 0, ms: 0, easing: 'linear' };
const riders = new Set<(move: KeyboardMove) => void>();
if (keyboardFromApp) {
  window.addEventListener('amble:keyboard', (e) => {
    keyboardAt = (e as CustomEvent<KeyboardMove>).detail;
    for (const ride of riders) ride(keyboardAt);
  });
}

/** A ref that keeps its element just above the keyboard, moving with it (the Android app only). */
export function rideKeyboard(el: HTMLElement | null) {
  if (!keyboardFromApp || !el) return;
  const ride = ({ to, ms, easing }: KeyboardMove, now = false) => {
    const still = now || !ms || matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.style.transition = still ? 'none' : `transform ${ms}ms ${easing}`;
    el.style.transform = to ? `translateY(${-to}px)` : '';
  };
  ride(keyboardAt, true);
  riders.add(ride);
  return () => void riders.delete(ride);
}

// The phone's Back while typing should drop the keyboard, as it does in Android apps. Chrome hands
// that Back to the page on some phones, where it would close the sheet being typed in or leave the
// page. This takes it first: it lets go of the text box and steps forward again, before the router
// or any sheet sees it. The keyboard counts as up when it covers a good part of the screen at
// normal zoom, or went down only a moment ago (Chrome may drop it on the way).
const KEYBOARD_MIN = 80;
let keyboardUp = false;
let keyboardDownAt = 0;
let undoingUntil = 0;

function keyboardShowing() {
  const vv = window.visualViewport;
  return !!vv && vv.scale < 1.05 && read().keyboard > KEYBOARD_MIN;
}

/** The text field being typed in, if any: the thing that raised the keyboard. */
function typingIn(): HTMLElement | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const text = el.matches(
    'textarea, [contenteditable]:not([contenteditable="false"]), input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=range], [type=color], [type=file], [type=date], [type=time], [type=datetime-local], [type=month], [type=week], [type=hidden])',
  );
  return text ? el : null;
}

/**
 * Whether someone is typing with the on-screen keyboard up (or it went down only a moment ago).
 * A tap or Back then only puts the keyboard away, as in Android apps.
 */
export function typingWithKeyboard() {
  return !!typingIn() && (keyboardUp || keyboardShowing() || Date.now() - keyboardDownAt < 500);
}

if (typeof window !== 'undefined' && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    const up = keyboardShowing();
    if (keyboardUp && !up) keyboardDownAt = Date.now();
    keyboardUp = up;
  });
  window.addEventListener(
    'popstate',
    (e) => {
      // The step forward again, which nothing else needs to hear about.
      if (Date.now() < undoingUntil) {
        undoingUntil = 0;
        e.stopImmediatePropagation();
        return;
      }
      const field = typingIn();
      if (!field || !typingWithKeyboard()) return;
      e.stopImmediatePropagation();
      field.blur();
      keyboardUp = false;
      undoingUntil = Date.now() + 1000;
      window.history.go(1);
    },
    // Capture listeners on the window run before the plain ones the router and sheets add.
    { capture: true },
  );
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

// A sheet that just closed with a tap, whose history entry is still on top until it takes it off.
let handingOver: string | null = null;

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
    // One sheet opening another as it closes (a menu's choice) takes over its entry, so a single
    // Back still leaves for the page.
    const replace = handingOver != null && window.history.state?.__sheet === handingOver;
    handingOver = null;
    window.history[replace ? 'replaceState' : 'pushState']({ ...window.history.state, __sheet: id }, '');
    const onPop = () => {
      if (window.history.state?.__sheet !== id) closeRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // Closed by a tap rather than Back: take our entry off again, unless something else
      // (a navigation, another sheet) has already moved on from it.
      if (window.history.state?.__sheet === id) handingOver = id;
      setTimeout(() => {
        if (handingOver === id) handingOver = null;
        if (!openRef.current && window.history.state?.__sheet === id) window.history.back();
      }, 0);
    };
  }, [open, id]);
}
