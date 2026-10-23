import { useEffect, useRef, useState } from 'react';
import { useBarTitles, useEdge } from '../lib/top-edge.ts';

/**
 * In the "Tinted bar with the page's name" look (Appearance): once the page's big title has
 * scrolled up under the status bar, the page's name shows in a bar just below it, in the status
 * bar's tone. Tapping it goes back to the top. Not while a task or list is open (`off`), whose
 * own title stays in its page.
 */
export function TopBar({ off }: { off: boolean }) {
  const edge = useEdge();
  const titles = useBarTitles();
  const bar = useRef<HTMLDivElement>(null);
  const [name, setName] = useState<string | null>(null);
  // Kept while the bar fades out, so the name doesn't go before it does.
  const [last, setLast] = useState('');
  if (name && name !== last) setLast(name);
  const on = edge === 'title' && !off;

  useEffect(() => {
    if (!on) return setName(null);
    let frame = 0;
    const check = () => {
      frame = 0;
      const b = bar.current;
      // Where the bar ends, showing or not: its slide doesn't move offsetTop.
      const bottom = b ? b.offsetTop + b.offsetHeight : 0;
      // The title of the page on screen; the others are built but out of sight.
      const title = titles.find((t) => t.el.isConnected && t.el.getClientRects().length > 0);
      setName(title && title.el.getBoundingClientRect().bottom < bottom ? title.text : null);
    };
    const soon = () => (frame ||= requestAnimationFrame(check));
    check();
    document.addEventListener('scroll', soon, { capture: true, passive: true });
    window.addEventListener('resize', soon);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', soon, { capture: true });
      window.removeEventListener('resize', soon);
    };
  }, [on, titles]);

  if (edge !== 'title') return null;
  return (
    <div
      ref={bar}
      aria-hidden
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      data-shown={name ? '' : undefined}
      className="top-bar fixed right-0"
      style={{ top: 'env(safe-area-inset-top)', left: 'var(--rail)', zIndex: 15 }}
    >
      <div className="mx-auto flex h-14 max-w-xl items-center px-4 medium:max-w-2xl medium:px-6">
        <span className="display truncate text-[1.375rem] font-medium">{name ?? last}</span>
      </div>
    </div>
  );
}
