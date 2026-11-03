// The server's own few pages (signing in, letting a device or an assistant in, the server's
// settings), as plain HTML. The app itself is the same everywhere and lives on the device.

/** Escapes text for HTML. */
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A raw piece of HTML, so `html` leaves it alone. */
export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

/** A template for HTML: everything put in is escaped unless it's already Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Html ? x.value : esc(x))).join('') : v instanceof Html ? v.value : v === false || v == null ? '' : esc(v);
    out += part + strings[i + 1]!;
  });
  return new Html(out);
}

const STYLE = `
:root{--bg:#f4fbf7;--surface:#e9efeb;--text:#171d1a;--muted:#404944;--primary:#2e6a57;--on-primary:#fff;--warm:#7a5900;--warm-bg:#ffdea3;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--surface:#1b211e;--text:#dee4df;--muted:#bfc9c2;--primary:#95d4bc;--on-primary:#00382a;--warm:#f6bd47;--warm-bg:#5c4300}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 "Google Sans Flex","Google Sans",system-ui,sans-serif}
main{max-width:34rem;margin:0 auto;padding:max(10vh,2rem) 1.5rem 3rem}
.brand{display:flex;align-items:center;gap:.6rem;color:var(--primary);font-weight:500;text-decoration:none}
.brand img{width:2rem;height:2rem}
h1{font-size:2rem;font-weight:500;line-height:1.2;margin:1.75rem 0 .75rem}
h2{font-size:1.15rem;font-weight:500;margin:2rem 0 .5rem}
p{margin:.5rem 0}
.muted{color:var(--muted);font-size:.95rem}
.card{background:var(--surface);border-radius:1.5rem;padding:1rem 1.25rem;margin:.75rem 0}
.row{display:flex;align-items:center;justify-content:space-between;gap:1rem}
.warn{background:var(--warm-bg);color:var(--text);border-radius:1.25rem;padding:.9rem 1.1rem;margin:1rem 0}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.5rem}
button,.button{font:inherit;font-weight:500;border:0;border-radius:999px;padding:.8rem 1.4rem;cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:var(--primary);color:var(--on-primary)}
.quiet{background:transparent;color:var(--primary);padding:.6rem 1rem}
.quiet:hover{background:var(--surface)}
form{margin:0}
input{font:inherit;width:100%;border:0;border-radius:1rem;padding:.85rem 1.1rem;margin:.75rem 0 0;background:var(--surface);color:var(--text)}
input:focus{outline:2px solid var(--primary)}
.code{font-size:2.25rem;font-weight:500;letter-spacing:.12em;text-align:center;margin:.5rem 0}
ul{list-style:none;padding:0;margin:0}
code{background:var(--surface);border-radius:.5rem;padding:.1rem .4rem;word-break:break-all}
`;

/** A whole page: the app's colors and type, Amble's mark at the top. */
export function page(title: string, body: Html, { base = '' }: { base?: string } = {}) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · Amble</title>
<link rel="icon" href="${base}/icon.svg">
<style>${new Html(STYLE)}</style>
</head>
<body><main>
<a class="brand" href="${base}/"><img src="${base}/icon.svg" alt="">Amble</a>
${body}
</main></body>
</html>`.value;
}
