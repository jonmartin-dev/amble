// Just enough Markdown for the privacy policy (docs/privacy-policy.md): headings, paragraphs, a
// bullet list and links.
import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    parts.push(
      text.slice(last, m.index),
      <a key={m.index} href={m[2]} className="font-medium text-primary underline-offset-2">
        {m[1]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** The policy past its title and date, which the page shows its own way. */
export function Markdown({ source }: { source: string }) {
  const blocks = source
    .trim()
    .split(/\n\s*\n/)
    .filter((b) => !b.startsWith('# ') && !b.startsWith('Last updated'));
  return blocks.map((block, i) => {
    if (block.startsWith('## '))
      return (
        <h2 key={i} className="display mt-10 text-2xl font-medium">
          {inline(block.slice(3))}
        </h2>
      );
    if (block.startsWith('- '))
      return (
        <ul key={i} className="mt-3 flex list-disc flex-col gap-1.5 pl-6">
          {block.split('\n').map((line, j) => (
            <li key={j}>{inline(line.slice(2))}</li>
          ))}
        </ul>
      );
    return (
      <p key={i} className="mt-3">
        {inline(block)}
      </p>
    );
  });
}
