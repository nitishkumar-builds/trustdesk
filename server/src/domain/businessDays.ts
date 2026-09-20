/**
 * Business-day arithmetic (Mon–Fri, UTC calendar days, no holiday table).
 *
 * RULE R1 applies here too: callers pass the ticket's created_at as the end of the interval.
 * Nothing in this file may call Date.now() or `new Date()` without an argument.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function isBusinessDay(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Number of business days strictly after `from` up to and including `to` (0 when to <= from). */
export function businessDaysBetween(from: Date, to: Date): number {
  let cursor = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  let count = 0;
  while (cursor.getTime() < end.getTime()) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (isBusinessDay(cursor)) count += 1;
  }
  return count;
}

/** The date `n` business days after `from` (same time of day). */
export function addBusinessDays(from: Date, n: number): Date {
  let cursor = new Date(from.getTime());
  let remaining = n;
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (isBusinessDay(cursor)) remaining -= 1;
  }
  return cursor;
}
