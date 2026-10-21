// What smart add shows while the model reads what was typed: the words lit one after another as
// if being read, cards waiting to be filled in, or Material's loading shape. Each is a choice in
// Settings, Motion, for now.
import { useEffect, useRef } from 'react';
import Sparkle from '~icons/material-symbols/auto-awesome-rounded';
import { reduced } from '../lib/motion-demo.ts';

// Material 3 Expressive's loading indicator turns through these shapes; as polygons with the same
// number of points, the browser can morph one into the next.
const POINTS = 60;
function polygon(radius: (a: number) => number, squash = 1) {
  const pts = Array.from({ length: POINTS }, (_, i) => {
    const a = (i / POINTS) * Math.PI * 2;
    const r = radius(a);
    return `${(50 + r * Math.cos(a)).toFixed(2)}% ${(50 + r * squash * Math.sin(a)).toFixed(2)}%`;
  });
  return `polygon(${pts.join(', ')})`;
}
const lobed = (lobes: number, depth: number) => (a: number) => (50 * (1 + depth * Math.cos(lobes * a))) / (1 + depth);
const SHAPES = [
  polygon(lobed(10, 0.09)), // soft burst
  polygon(lobed(9, 0.06)), // cookie
  polygon(lobed(5, 0.1)), // pentagon, softened
  polygon(() => 50, 0.62), // pill
  polygon(lobed(8, 0.12)), // sunny
  polygon(lobed(4, 0.1)), // four-sided cookie
  polygon(() => 50, 0.82), // oval
];

/**
 * Material's loading indicator: a shape that morphs through the set while it turns. The two are on
 * separate elements so the turn, a plain rotation, runs on the phone's compositor whatever the page
 * is doing; if the morph, which the page draws, is held up, the shape still keeps turning.
 */
export function LoadingShape({ className = '', tone }: { className?: string; tone: string }) {
  const turn = useRef<HTMLSpanElement>(null);
  const shape = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!turn.current || !shape.current || reduced()) return;
    const ease = 'cubic-bezier(0.4, 0, 0.2, 1)';
    const moves = [
      shape.current.animate(
        [...SHAPES, SHAPES[0]!].map((clipPath) => ({ clipPath, easing: ease })),
        { duration: 650 * SHAPES.length, iterations: Infinity },
      ),
      turn.current.animate({ transform: ['rotate(0deg)', 'rotate(360deg)'] }, { duration: 4200, iterations: Infinity }),
    ];
    return () => moves.forEach((a) => a.cancel());
  }, []);
  return (
    <span ref={turn} aria-hidden className={`block ${className}`}>
      <span ref={shape} className={`absolute inset-0 ${tone}`} style={{ clipPath: SHAPES[0] }} />
    </span>
  );
}

/** The words, lit one after another while the model reads them, round and round without a pause. */
export function ReadAlong({ text, className }: { text: string; className: string }) {
  const parts = text.split(/(\s+)/);
  const words = parts.filter((p) => p && !/^\s+$/.test(p)).length;
  const step = 0.1;
  // One pass, then a beat, then the next: there's always a word being read.
  const period = Math.max(1.2, (words + 3) * step);
  let n = 0;
  return (
    <p aria-hidden className={className}>
      {parts.map((p, i) =>
        !p || /^\s+$/.test(p) ? (
          p
        ) : (
          <span key={i} className="read-word" style={{ animationDuration: `${period}s`, animationDelay: `${n++ * step}s` }}>
            {p}
          </span>
        ),
      )}
    </p>
  );
}

/** About how many things were typed: commas, "and", new lines. */
export function guessCount(text: string) {
  return Math.min(Math.max(text.split(/,|;|\n|\band\b|\balso\b/i).filter((s) => s.trim().length > 1).length, 1), 4);
}

/** Cards waiting to be filled in, a light sweeping over them. */
export function WaitingCards({ count }: { count: number }) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Reading">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="waiting-card flex items-start gap-3 rounded-3xl bg-surface-high/60 p-3" style={{ animationDelay: `${i * 0.12}s` }}>
          <span className="size-9 shrink-0 rounded-full bg-secondary-container" />
          <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <span className="h-3.5 rounded-full bg-on-surface/10" style={{ width: `${[72, 55, 64, 48][i % 4]}%` }} />
            <span className="h-2.5 w-1/3 rounded-full bg-on-surface/8" />
          </span>
          <span className="size-6 shrink-0 rounded-md bg-on-surface/8" />
        </li>
      ))}
    </ul>
  );
}

/** The big version: the shape over a line saying what's happening. */
export function ReadingShape() {
  return (
    <div className="flex flex-col items-center py-4" aria-label="Reading">
      <div className="relative grid size-24 place-items-center">
        <LoadingShape className="absolute inset-0" tone="bg-primary-container" />
        <Sparkle className="relative size-8 text-on-primary-container" aria-hidden />
      </div>
      <p className="mt-3 text-sm text-on-surface-variant">Reading what you wrote…</p>
    </div>
  );
}
