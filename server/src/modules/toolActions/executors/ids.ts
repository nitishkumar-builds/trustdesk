import { randomBytes } from 'node:crypto';

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Six lowercase alphanumerics for simulated downstream identifiers (ord_r_xxxxxx, rr_xxxxxx, ...). */
export function shortId(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) out += ALPHANUMERIC[b % ALPHANUMERIC.length];
  return out;
}
