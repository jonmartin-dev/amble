// What smart add shows while the model reads what was typed: a light sweeping across the words until
// the first card comes, then a card waiting at the end of the list for the next one, and Material's
// loading shape in the send button throughout.
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { expressive } from '../lib/motion.ts';
import { reduced } from '../lib/motion-settings.ts';

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

/**
 * The words with a light sweeping across them while the model reads. The light is a band that slides
 * over the words holding its own copy of them in the highlight color, which slides back the other
 * way at the same pace so the copy stays on the words. Both moves are transforms, so the phone runs
 * them on its own however busy the page is. `lines` is the text's own padding and type, given to
 * both copies so they line up.
 */
export function ShimmerText({ text, className, lines }: { text: string; className: string; lines: string }) {
  const band = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!band.current || !copy.current || reduced()) return;
    const timing = { duration: 1800, iterations: Infinity, easing: 'linear' };
    // The band is 2/5 of the width: it starts just off the left edge and ends just off the right,
    // and the copy, the full width, moves the same distance back.
    const moves = [
      band.current.animate({ transform: ['translateX(-100%)', 'translateX(250%)'] }, timing),
      copy.current.animate({ transform: ['translateX(40%)', 'translateX(-100%)'] }, timing),
    ];
    return () => moves.forEach((a) => a.cancel());
  }, []);
  return (
    <div aria-hidden className={className}>
      <p className={`${lines} text-on-surface-variant`}>{text}</p>
      <div
        ref={band}
        className="absolute inset-y-0 left-0 w-2/5 overflow-hidden"
        style={{ maskImage: 'linear-gradient(90deg, transparent, #000 50%, transparent)' }}
      >
        <p ref={copy} className={`${lines} w-[250%] text-primary`}>
          {text}
        </p>
      </div>
    </div>
  );
}

/** A card waiting at the end of the list while the model writes the next, a light sweeping over it. */
export function WaitingCard() {
  return (
    <motion.li
      layout
      aria-label="Reading the rest"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ ...expressive.defaultSpatial, layout: expressive.fastSpatial }}
      className="rounded-3xl"
    >
      <div className="waiting-card flex items-start gap-3 rounded-3xl bg-surface-high/60 p-3">
        <span className="size-9 shrink-0 rounded-full bg-secondary-container" />
        <span className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <span className="h-3.5 w-3/5 rounded-full bg-on-surface/10" />
          <span className="h-2.5 w-1/3 rounded-full bg-on-surface/8" />
        </span>
        <span className="size-6 shrink-0 rounded-md bg-on-surface/8" />
      </div>
    </motion.li>
  );
}
