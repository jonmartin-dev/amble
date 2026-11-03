// Prints a code that lets a phone or computer into this server, for when nobody's in yet to make
// one: deploy/setup.sh runs it inside the container once the server is up.
//
//   node server/pair.ts admin    a code that makes whoever uses it an admin (lasts a day)
//   node server/pair.ts          a code that brings in someone new (lasts 10 minutes)
import { encode } from 'uqr';
import { joinLink } from '../shared/qr.ts';
import { makeCode } from './auth/pairing.ts';
import { config } from './config.ts';
import { openDatabase } from './db/index.ts';

const admin = process.argv[2] === 'admin';
const db = openDatabase();
const { code, expiresAt } = makeCode(db, { kind: 'invite', role: admin ? 'admin' : 'member', by: null });
const link = joinLink(config.publicUrl, code);

/**
 * The QR code in the terminal, two rows of modules to a line. Light modules print as blocks, so on a
 * dark terminal the code comes out dark on light, the way scanners read it.
 */
function terminalQr(text: string) {
  const { data } = encode(text, { ecc: 'M', border: 2 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    let line = '';
    for (let x = 0; x < data[y]!.length; x++) {
      const top = !data[y]![x];
      const bottom = y + 1 < data.length ? !data[y + 1]![x] : true;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const until = expiresAt.toLocaleString('en-US', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'short' });
console.log(`
${terminalQr(link)}

In the Amble app on your phone, choose "Use my own server", then "Scan the code" and scan the
code above. On an iPhone or a computer, open this link, or type the address and the code:

  ${link}

  Code: ${code}

It works once${admin ? ' and makes whoever uses it an admin' : ''}. It lasts until ${until}.`);
