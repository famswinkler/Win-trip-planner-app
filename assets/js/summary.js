// Builds the plain-text, bullet-point trip summary.
//
// This is deliberately text, not markup: it has to survive being copied into
// a message, printed, read aloud, or pasted to a travel companion — and it is
// the thing you fall back on when the battery is low and the network is gone.

import { byStart, chf, dayKey, eur, fmtDayLong, fmtTime, kindLabel, parseDate } from './util.js';

function line(out, text) { out.push(text); }
function bullet(out, text, depth = 0) { out.push(`${'  '.repeat(depth)}- ${text}`); }

function itemLine(item, tz) {
  const time = fmtTime(item.start, tz);
  const head = time ? `${time} — ${item.title}` : item.title;
  const bits = [];
  if (item.location) bits.push(item.location);
  if (item.legKm) bits.push(`${item.legKm} km`);
  if (item.legDuration) bits.push(item.legDuration);
  return bits.length ? `${head} (${bits.join(', ')})` : head;
}

/**
 * @param {object} trip
 * @param {{includePrivate?: boolean}} [opts] include booking refs and PINs.
 *   Off by default so a shared summary never leaks credentials.
 */
export function buildSummary(trip, opts = {}) {
  const includePrivate = opts.includePrivate === true;
  const tz = trip.timezone || 'Europe/Zurich';
  const out = [];

  line(out, trip.title.toUpperCase());
  if (trip.subtitle) line(out, trip.subtitle);
  line(out, `${fmtDayLong(trip.start, tz)} to ${fmtDayLong(trip.end, tz)}`);
  if (trip.party) {
    const p = trip.party;
    const kids = p.childAges?.length ? ` (${p.childAges.join(' and ')})` : '';
    line(out, `${p.adults} adults, ${p.children} children${kids}`);
  }
  line(out, '');

  // --- deadlines first: these are the things that cost money if missed.
  const open = (trip.deadlines || []).filter((d) => !d.done).sort((a, b) => (parseDate(a.due) || 0) - (parseDate(b.due) || 0));
  if (open.length) {
    line(out, 'BEFORE YOU GO');
    for (const d of open) {
      bullet(out, `${fmtDayLong(d.due, tz)}: ${d.title}`);
      if (d.detail) bullet(out, d.detail, 1);
    }
    line(out, '');
  }

  // --- key contacts, because this is what you need when something goes wrong.
  const contacts = (trip.contacts || []).filter((c) => c.phone || c.web);
  if (contacts.length) {
    line(out, 'CONTACTS');
    for (const c of contacts) {
      const detail = [c.role, c.phone, c.web].filter(Boolean).join(' — ');
      bullet(out, `${c.name}: ${detail}`);
    }
    line(out, '');
  }

  // --- day by day.
  line(out, 'ITINERARY');
  const items = [...(trip.items || [])].sort(byStart);
  const days = new Map();
  for (const item of items) {
    const key = dayKey(item.start, tz) || 'undated';
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(item);
  }
  for (const [key, list] of days) {
    line(out, '');
    line(out, key === 'undated' ? 'No date yet' : fmtDayLong(`${key}T12:00:00`, tz));
    for (const item of list) {
      bullet(out, itemLine(item, tz));
      for (const d of item.details || []) bullet(out, d, 1);
      if (item.booking) {
        const b = item.booking;
        if (b.room) bullet(out, b.room, 1);
        if (b.checkInWindow) bullet(out, `Check-in ${b.checkInWindow}`, 1);
        if (b.checkOutWindow) bullet(out, `Check-out ${b.checkOutWindow}`, 1);
        if (b.paymentNote) bullet(out, b.paymentNote, 1);
        if (b.cancellation) bullet(out, `Cancellation: ${b.cancellation}`, 1);
        if (includePrivate && b.private) {
          for (const [k, v] of Object.entries(b.private)) {
            if (v) bullet(out, `${k}: ${v}`, 1);
          }
        }
      }
      if (item.phone) bullet(out, `Phone: ${item.phone}`, 1);
      if (item.coords) bullet(out, `GPS: ${item.coords.lat.toFixed(5)}, ${item.coords.lon.toFixed(5)}`, 1);
    }
  }

  // --- money.
  if (trip.budget?.length) {
    line(out, '');
    line(out, 'MONEY');
    let due = 0;
    let paid = 0;
    for (const row of trip.budget) {
      const amount = Number(row.chf) || 0;
      if (row.status === 'paid') paid += amount; else due += amount;
      const tag = row.status === 'paid' ? ' [paid]' : row.status === 'optional' ? ' [optional]' : '';
      bullet(out, `${row.label}: ${chf(amount)}${tag}${row.detail ? ` — ${row.detail}` : ''}`);
    }
    bullet(out, `Still to pay: ${chf(due)}`);
    bullet(out, `Already paid: ${chf(paid)}`);
  }

  // --- reference guides (tolls, food, packing).
  for (const guide of trip.guides || []) {
    line(out, '');
    line(out, guide.title.toUpperCase());
    for (const b of guide.bullets || []) bullet(out, b);
  }

  if (trip.vehicle) {
    line(out, '');
    line(out, 'VEHICLE');
    bullet(out, trip.vehicle.model);
    if (trip.vehicle.rangeLoadedKm) bullet(out, `Range: ${trip.vehicle.rangeLoadedKm}`);
    if (trip.vehicle.chargeEveryKm) bullet(out, `Charge every ${trip.vehicle.chargeEveryKm}`);
    for (const n of trip.vehicle.notes || []) bullet(out, n);
  }

  line(out, '');
  line(out, `Saved offline. Last updated ${new Date(trip.updatedAt || Date.now()).toLocaleString('en-GB')}.`);
  if (!includePrivate) line(out, 'Booking references and PINs are hidden in this copy.');

  return out.join('\n');
}

/** A very short version, for the Now screen and for the assistant's context. */
export function buildBrief(trip, now = new Date()) {
  const tz = trip.timezone || 'Europe/Zurich';
  const items = [...(trip.items || [])].sort(byStart);
  const upcoming = items.filter((i) => {
    const end = parseDate(i.end) || parseDate(i.start);
    return end && end >= now;
  });
  const lines = [`${trip.title} — ${fmtDayLong(trip.start, tz)} to ${fmtDayLong(trip.end, tz)}`];
  for (const item of upcoming.slice(0, 6)) {
    lines.push(`- ${fmtDayLong(item.start, tz)} ${fmtTime(item.start, tz)} ${kindLabel(item.type)}: ${item.title}${item.location ? ` @ ${item.location}` : ''}`);
  }
  const money = (trip.budget || []).filter((b) => b.status !== 'paid').reduce((s, b) => s + (Number(b.chf) || 0), 0);
  lines.push(`Outstanding budget: ${chf(money)}`);
  return lines.join('\n');
}

/** Everything the assistant is allowed to see, as compact text. */
export function buildAiContext(trip) {
  const base = buildSummary(trip, { includePrivate: false });
  const extra = [];
  if (trip.budget?.length) {
    const eurTotals = (trip.items || [])
      .filter((i) => i.booking?.totalEur)
      .map((i) => `${i.title}: ${eur(i.booking.totalEur)}${i.booking.paid ? ' (paid)' : ' (due)'}`);
    if (eurTotals.length) extra.push(`Booking totals in euro: ${eurTotals.join('; ')}`);
  }
  return extra.length ? `${base}\n\n${extra.join('\n')}` : base;
}
