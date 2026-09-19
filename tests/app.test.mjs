import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const trip = JSON.parse(readFileSync(new URL('../data/trip-spain-2026.json', import.meta.url)));

const util = await import('../assets/js/util.js');
const summary = await import('../assets/js/summary.js');
const ingest = await import('../assets/js/ingest.js');
const gemini = await import('../assets/js/gemini.js');

test('seed trip is structurally sound', () => {
  assert.equal(trip.schemaVersion, 1);
  assert.ok(trip.items.length > 10);
  const ids = trip.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'item ids must be unique');
  for (const item of trip.items) {
    assert.ok(item.title, `item ${item.id} needs a title`);
    assert.ok(util.parseDate(item.start), `item ${item.id} needs a parseable start`);
    if (item.end) assert.ok(util.parseDate(item.end) >= util.parseDate(item.start), `${item.id} ends before it starts`);
  }
});

test('every item falls inside the trip window', () => {
  const lo = util.parseDate(`${trip.start}T00:00:00`).getTime() - 2 * 86400000;
  const hi = util.parseDate(`${trip.end}T23:59:59`).getTime() + 86400000;
  for (const item of trip.items) {
    const s = util.parseDate(item.start).getTime();
    assert.ok(s >= lo && s <= hi, `${item.id} at ${item.start} is outside the trip`);
  }
});

test('no credentials are committed in the seed', () => {
  const raw = readFileSync(new URL('../data/trip-spain-2026.json', import.meta.url), 'utf8');
  assert.ok(!/\bPIN\s*[:=]\s*\d{4}/i.test(raw), 'a PIN leaked into the seed');
  assert.ok(!/CH\d{2}\s?\d{4}\s?\d{4}/.test(raw), 'an IBAN leaked into the seed');
  assert.ok(!/\b\d{10}\b/.test(raw), 'a booking reference leaked into the seed');
  for (const item of trip.items) {
    for (const v of Object.values(item.booking?.private || {})) {
      assert.equal(v, null, `${item.id} ships a private value`);
    }
  }
});

test('escaping neutralises HTML', () => {
  assert.equal(util.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(util.esc(null), '');
});

test('parseDate refuses rubbish rather than returning Invalid Date', () => {
  assert.equal(util.parseDate('not a date'), null);
  assert.equal(util.parseDate(''), null);
  assert.equal(util.parseDate(undefined), null);
});

test('summary contains the things you need at a border', () => {
  const text = summary.buildSummary(trip);
  for (const needle of ['BEFORE YOU GO', 'CONTACTS', 'ITINERARY', 'MONEY', '112', 'Tamarit']) {
    assert.ok(text.includes(needle), `summary is missing ${needle}`);
  }
  assert.ok(text.length > 4000, 'summary looks truncated');
});

test('summary hides private details unless asked', () => {
  const withPin = JSON.parse(JSON.stringify(trip));
  withPin.items.find((i) => i.id === 'beziers-stay').booking.private.pin = '9999';
  assert.ok(!summary.buildSummary(withPin).includes('9999'));
  assert.ok(summary.buildSummary(withPin, { includePrivate: true }).includes('9999'));
});

test('a cancellation email is flagged as an urgent change', () => {
  const mail = [{
    id: 'm-cancel',
    subject: 'Your reservation in Béziers was cancelled',
    from: 'noreply@booking.com',
    internalDate: Date.now(),
    snippet: 'cancelled',
    body: 'Your reservation 1234567890 for 2 October 2026 was cancelled. Refund € 146.56',
  }];
  const [s] = ingest.suggestionsFromMail(mail, trip, []);
  assert.equal(s.kind, 'change');
  assert.equal(s.severity, 'high');
  assert.ok(s.facts.some((f) => f.includes('1234567890')));
});

test('marketing mail is ignored', () => {
  const mail = [{
    id: 'm-spam', subject: '20% off all champagnes', from: 'newsletter@news.coop.ch',
    internalDate: Date.now(), snippet: 'weekend hits', body: 'Our free newsletters keep you updated on offers.',
  }];
  assert.equal(ingest.suggestionsFromMail(mail, trip, []).length, 0);
});

test('already-seen mail is not re-proposed', () => {
  const mail = [{
    id: 'seen-1', subject: 'Booking confirmed at Novotel Avignon Centre', from: 'noreply@booking.com',
    internalDate: Date.now(), snippet: 'confirmed', body: 'Confirmation 9876543210 check-in 10 October 2026',
  }];
  assert.equal(ingest.suggestionsFromMail(mail, trip, ['seen-1']).length, 0);
});

test('duplicate calendar entries are detected across title variants', () => {
  const events = [
    { id: 'a', title: 'Stay: Centre Historique - FREE Parking - SLEEPNTRIPBEZIERS', start: '2026-10-02T00:00:00+02:00' },
    { id: 'b', title: 'Centre Historique - FREE Parking - Self Checkin - SLEEPNTRIPBEZIERS', start: '2026-10-02T16:00:00+02:00' },
    { id: 'c', title: 'Centre Historique - SLEEPNTRIPBEZIERS Booking', start: '2026-10-02T16:00:00+02:00' },
  ];
  const dupes = ingest.suggestionsFromCalendar(events, trip).filter((s) => s.kind === 'duplicate');
  assert.equal(dupes.length, 1);
  assert.ok(dupes[0].title.includes('3 duplicate'));
});

test('events already in the plan are not proposed again', () => {
  const events = [
    { id: 'x', title: 'Stay at Novotel Avignon Centre', start: '2026-10-10T15:00:00+02:00' },
    { id: 'y', title: 'Church Erläbt Camp', start: '2026-10-03T00:00:00+02:00' },
  ];
  assert.equal(ingest.suggestionsFromCalendar(events, trip).filter((s) => s.kind === 'add').length, 0);
});

test('domestic routine is filtered out of trip suggestions', () => {
  const events = [
    { id: 'r1', title: 'GOD & family time', start: '2026-10-05T19:30:00+02:00' },
    { id: 'r2', title: 'BSF Kids', start: '2026-10-05T19:15:00+02:00' },
    { id: 'r3', title: 'Homeoffice', start: '2026-10-05T00:00:00+02:00' },
  ];
  assert.equal(ingest.suggestionsFromCalendar(events, trip).length, 0);
});

test('offline answers find dietary guidance', () => {
  const answer = gemini.offlineAnswer(trip, 'can I eat chorizo', 'From your saved trip:');
  assert.ok(answer && /chorizo/i.test(answer));
  assert.equal(gemini.offlineAnswer(trip, 'zzzz', 'x'), null);
});

test('budget maths add up', () => {
  const due = trip.budget.filter((b) => b.status === 'due').reduce((s, b) => s + b.chf, 0);
  const paid = trip.budget.filter((b) => b.status === 'paid').reduce((s, b) => s + b.chf, 0);
  assert.ok(due > 0 && paid > 0);
  assert.ok(summary.buildSummary(trip).includes(util.chf(due + trip.budget.filter((b) => b.status === 'optional').reduce((s, b) => s + b.chf, 0))));
});

test('the Gemini call refuses to run without a key', async () => {
  await assert.rejects(
    () => gemini.askGemini({ apiKey: '', context: '', question: 'hi' }),
    /Setup/,
  );
});
