// Answers that come a piece at a time, one JSON object to a line: smart add's proposals as the model
// writes them, and the model's words on their way from the household's server to a device.

/** A response that writes each object `run` hands it as a line, as soon as it's handed. */
export function linesResponse(run: (write: (line: unknown) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (line: unknown) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      };
      try {
        await run(write);
      } finally {
        open = false;
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { 'content-type': LINES_TYPE, 'cache-control': 'no-store' } });
}

export const LINES_TYPE = 'application/x-ndjson';

export const isLines = (res: Response) => res.headers.get('content-type')?.startsWith(LINES_TYPE) ?? false;

/** Calls `onLine` with each line of a body as it arrives; a last line without its break counts too. */
export async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    if (done) break;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line) onLine(line);
    }
  }
  if (buffer.trim()) onLine(buffer.trim());
}
