// Turning raw Gmail and Calendar data into proposed changes.
//
// The rule here is that sync never silently rewrites your trip. It produces
// *suggestions* which you accept or dismiss. An email parser that is wrong
// about a date is annoying; one that is wrong and applies itself automatically
// is how you end up at the wrong hotel.

import { dayKey, parseDate, uid } from './util.js';

const MONEY = /(?:€|EUR)\s*([0-9][0-9.,]*)|([0-9][0-9.,]*)\s*(?:€|EUR)/i;
const CONFIRMATION = /(?:confirmation|booking|reservation|buchung|bestätigung|reservierung)\s*(?:number|no\.?|nummer|#|:)?\s*([A-Z0-9]{5,})/i;
const PIN = /\bPIN[:\s]*([0-9]{4,6})\b/i;

/** Words that mark a message as travel-relevant at all. */
const TRAVEL_HINTS = [
  'booking', 'reservation', 'confirmed', 'confirmation', 'check-in', 'checkin',
  'itinerary', 'boarding', 'flight', 'hotel', 'apartment', 'buchung',
  'bestätigung', 'reservierung', 'anreise', 'abreise', 'camp', 'ticket',
  'cancell', 'storno', 'refund', 'delay', 'verspätung', 'parking',
];

const CHANGE_HINTS = [
  'cancell', 'canceled', 'cancelled', 'storno', 'changed', 'change to',
  'rescheduled', 'delay', 'verspätung', 'geändert', 'updated', 'new time',
  'refund', 'declined', 'unavailable', 'overbook',
];

function normalise(text) {
  return (text || '').replace(/\s+/g, ' ').toLowerCase();
}

/** Noise words that say nothing about *which* thing a title refers to. */
const STOP_WORDS = new Set([
  'stay', 'booking', 'hotel', 'the', 'and', 'with', 'your', 'for', 'free',
  'self', 'checkin', 'check', 'wifi', 'parking', 'reservation', 'confirmation',
]);

/**
 * Reduce a title to its identifying tokens. Prefix slicing was not enough:
 * "Stay: Centre Historique - SLEEPNTRIPBEZIERS" and
 * "Centre Historique - FREE Parking - SLEEPNTRIPBEZIERS" are the same place
 * but share no common prefix.
 */
function titleTokens(text) {
  return new Set(
    normalise(text)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // fold accents: beziers === béziers
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(' ')
      .map((w) => w.trim())
      .filter((w) => w.length >= 4 && !STOP_WORDS.has(w)),
  );
}

/**
 * Two tokens count as the same when they are equal, or when one is a prefix of
 * the other and long enough to be meaningful. That lets "sleepntrip" match
 * "sleepntripbeziers", which is how the same property is written in Booking's
 * confirmation and in the calendar entry it generates.
 */
function tokenMatches(a, set) {
  if (set.has(a)) return true;
  for (const b of set) {
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length >= 6 && long.startsWith(short)) return true;
  }
  return false;
}

/** Overlap coefficient: 1 when one title's tokens are a subset of the other's. */
function titleSimilarity(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tokenMatches(t, tb)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

const SAME_THING = 0.6;

/**
 * Score a message on two independent axes.
 *
 * The change words only count once the message is travel-related at all.
 * Without that gate a shop newsletter saying "updated" scores as an urgent
 * booking change, which is exactly the kind of false alarm that trains you to
 * ignore the app.
 */
function scoreMessage(message) {
  const hay = normalise(`${message.subject} ${message.snippet} ${message.body?.slice(0, 2000)}`);
  let travel = 0;
  for (const hint of TRAVEL_HINTS) if (hay.includes(hint)) travel += 1;
  let change = 0;
  for (const hint of CHANGE_HINTS) if (hay.includes(hint)) change += 1;
  return { travel, change, total: travel === 0 ? 0 : travel + change * 2 };
}

function firstMatch(re, text) {
  const m = re.exec(text || '');
  if (!m) return null;
  return (m[1] ?? m[2] ?? '').trim() || null;
}

/** Pull dates out of a message body, keeping only ones inside the trip window. */
function datesIn(text, trip) {
  const found = new Set();
  const tripStart = parseDate(trip.start);
  const tripEnd = parseDate(trip.end);
  if (!tripStart || !tripEnd) return [];
  // Widen a little either side so pre- and post-trip changes still register.
  const lo = new Date(tripStart.getTime() - 14 * 86400000);
  const hi = new Date(tripEnd.getTime() + 14 * 86400000);

  const patterns = [
    /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g,                 // 02.10.2026
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,                           // 2026-10-02
    /\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/gi,
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi,
  ];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      let iso = null;
      if (re.source.startsWith('\\b(\\d{1,2})[./]')) {
        iso = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
      } else if (re.source.startsWith('\\b(\\d{4})')) {
        iso = `${m[1]}-${m[2]}-${m[3]}`;
      } else if (/^\d/.test(m[1])) {
        const mi = MONTHS.indexOf(m[2].toLowerCase());
        if (mi >= 0) iso = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
      } else {
        const mi = MONTHS.indexOf(m[1].toLowerCase());
        if (mi >= 0) iso = `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
      }
      if (!iso) continue;
      const d = parseDate(`${iso}T12:00:00`);
      if (d && d >= lo && d <= hi) found.add(iso);
    }
  }
  return [...found].sort();
}

/** Which existing trip item does this message most likely concern? */
function matchItem(message, trip) {
  const hay = normalise(`${message.subject} ${message.body?.slice(0, 4000)}`);
  let best = null;
  let bestScore = 0;
  for (const item of trip.items || []) {
    const words = normalise(item.title).split(' ').filter((w) => w.length > 4);
    const locWords = normalise(item.location).split(/[\s,]+/).filter((w) => w.length > 4);
    let score = 0;
    for (const w of new Set([...words, ...locWords])) if (hay.includes(w)) score += 1;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * Build suggestions from a batch of Gmail messages.
 * @returns {Array<object>} suggestion records, newest first.
 */
export function suggestionsFromMail(messages, trip, seenIds = []) {
  const seen = new Set(seenIds);
  const out = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    const score = scoreMessage(message);
    if (score.travel < 1 || score.total < 2) continue;

    const text = `${message.subject}\n${message.body || message.snippet || ''}`;
    const related = matchItem(message, trip);
    const dates = datesIn(text, trip);
    const isChange = score.change > 0;

    const facts = [];
    const ref = firstMatch(CONFIRMATION, text);
    if (ref) facts.push(`Reference ${ref}`);
    const pin = firstMatch(PIN, text);
    if (pin) facts.push(`PIN ${pin}`);
    const money = firstMatch(MONEY, text);
    if (money) facts.push(`Amount € ${money}`);
    if (dates.length) facts.push(`Dates mentioned: ${dates.join(', ')}`);

    out.push({
      id: uid('sug'),
      kind: isChange ? 'change' : 'info',
      severity: isChange ? 'high' : 'normal',
      title: message.subject || '(no subject)',
      from: message.from,
      receivedAt: message.internalDate ? new Date(message.internalDate).toISOString() : null,
      excerpt: (message.snippet || message.body || '').slice(0, 320),
      facts,
      relatedItemId: related?.id || null,
      relatedItemTitle: related?.title || null,
      link: message.link,
      source: { kind: 'gmail', id: message.id },
      status: 'new',
    });
  }
  return out.sort((a, b) => (b.receivedAt || '').localeCompare(a.receivedAt || ''));
}

/**
 * Compare fresh calendar events against the trip and flag genuine differences.
 * Also catches the duplicate-event problem that Gmail's automatic calendar
 * entries create when a booking is also added by hand.
 */
export function suggestionsFromCalendar(events, trip) {
  const tz = trip.timezone || 'Europe/Zurich';
  const out = [];

  // 1. Duplicate detection: same day, near-identical titles.
  const byDay = new Map();
  for (const e of events) {
    const key = dayKey(e.start, tz);
    if (!key) continue;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  for (const [day, list] of byDay) {
    // Cluster by similarity rather than by a shared prefix.
    const clusters = [];
    for (const e of list) {
      if (!titleTokens(e.title).size) continue;
      const hit = clusters.find((c) => titleSimilarity(c[0].title, e.title) >= SAME_THING);
      if (hit) hit.push(e); else clusters.push([e]);
    }
    for (const group of clusters) {
      if (group.length < 2) continue;
      out.push({
        id: uid('sug'),
        kind: 'duplicate',
        severity: 'normal',
        title: `${group.length} duplicate calendar entries on ${day}`,
        excerpt: group.map((e) => e.title).join(' • ').slice(0, 320),
        facts: [`Tidy these up in Google Calendar so the timeline reads cleanly.`],
        source: { kind: 'calendar', id: group[0].id },
        status: 'new',
      });
    }
  }

  // 2. Events inside the trip window that the plan does not know about.
  const planTitles = (trip.items || []).map((i) => i.title);
  const tripStart = parseDate(trip.start);
  const tripEnd = parseDate(trip.end);
  const proposed = [];
  for (const e of events) {
    const start = parseDate(e.start);
    if (!start || !tripStart || !tripEnd) continue;
    if (start < tripStart || start > tripEnd) continue;
    if (planTitles.some((t) => titleSimilarity(t, e.title) >= SAME_THING)) continue;
    // Recurring domestic routine is noise on a trip screen.
    if (/god & family|bsf|homeoffice|week numbers/i.test(e.title)) continue;
    if (proposed.some((t) => titleSimilarity(t, e.title) >= SAME_THING)) continue;
    proposed.push(e.title);
    out.push({
      id: uid('sug'),
      kind: 'add',
      severity: 'normal',
      title: `Calendar event not in your plan: ${e.title}`,
      excerpt: [e.location, e.description].filter(Boolean).join(' — ').slice(0, 320),
      facts: [`Starts ${e.start}`],
      proposedItem: {
        type: 'event',
        title: e.title,
        start: e.start,
        end: e.end,
        location: e.location || '',
        details: e.description ? [e.description.slice(0, 400)] : [],
        source: { kind: 'calendar', id: e.id },
      },
      source: { kind: 'calendar', id: e.id },
      status: 'new',
    });
  }
  return out;
}

/** Default Gmail query for a trip: recent travel mail naming the trip's places. */
export function defaultGmailQuery(trip) {
  const places = new Set();
  for (const item of trip.items || []) {
    const loc = item.location || '';
    const city = loc.split(',').map((s) => s.trim()).filter(Boolean).pop();
    const town = loc.split(',')[0]?.replace(/^\d+\s*/, '').trim();
    for (const candidate of [city, town, item.booking?.provider]) {
      if (candidate && candidate.length > 3 && !/^\d/.test(candidate)) places.add(candidate.split(' ').slice(-1)[0]);
    }
  }
  const terms = [...places].slice(0, 8).map((p) => `"${p}"`).join(' OR ');
  const window = 'newer_than:45d';
  return terms
    ? `${window} (${terms} OR booking OR reservation OR confirmation OR Buchung)`
    : `${window} (booking OR reservation OR confirmation)`;
}
