// Ids worked out from what a row is, rather than drawn at random, for rows two devices might each
// make on their own: the next task a repeating one makes when it's finished, its steps and files,
// and a person's reminder on a task. When those devices sync, both made the same row, so it merges
// instead of showing up twice.

/** A UUID (version 8, RFC 9562) that depends only on `name`. */
export function uuidFrom(name: string): string {
  // cyrb128: four 32-bit lanes, plenty to keep ids apart within one household.
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < name.length; i++) {
    const k = name.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  const hex = [h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
  // Version 8 in the 13th digit, the RFC variant in the 17th.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The one reminder a person can have on a task. */
export const reminderId = (taskId: string, memberId: string) => uuidFrom(`reminder:${taskId}:${memberId}`);
