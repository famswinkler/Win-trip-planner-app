// Rendering. Every view is a pure function from state to an HTML string;
// app.js owns the events. Keeping it that way makes the whole UI re-renderable
// after any edit without tracking which node changed.

import {
  byStart, chf, dayKey, esc, eur, fmtDateRange, fmtDayLong, fmtDayShort, fmtTime, kindGlyph,
  kindLabel, mapLinks, parseDate, relativeWhen, ITEM_TYPES,
} from './util.js';
import { buildSummary } from './summary.js';
import { starterQuestions } from './gemini.js';

const EMPTY = '<p class="muted">Nothing here yet.</p>';

function severityChip(severity) {
  if (severity === 'high') return '<span class="chip danger">Act now</span>';
  if (severity === 'medium') return '<span class="chip warn">Soon</span>';
  return '<span class="chip">Note</span>';
}

function itemActions(item) {
  const links = mapLinks(item);
  const out = [];
  if (links) {
    out.push(`<a class="btn small ghost" href="${esc(links.google)}" target="_blank" rel="noopener">Map</a>`);
    if (links.coords) out.push(`<button class="btn small ghost" data-copy="${esc(links.coords)}" type="button">GPS</button>`);
  }
  if (item.phone) out.push(`<a class="btn small ghost" href="tel:${esc(item.phone.replace(/\s/g, ''))}">Call</a>`);
  out.push(`<button class="btn small ghost" data-edit="${esc(item.id)}" type="button">Edit</button>`);
  return `<div class="item-actions">${out.join('')}</div>`;
}

function renderItem(item, tz, { now = new Date(), showActions = true } = {}) {
  const start = parseDate(item.start);
  const end = parseDate(item.end) || start;
  const isNow = start && end && start <= now && now <= end;
  const meta = [];
  if (item.location) meta.push(esc(item.location));
  if (item.legKm) meta.push(`${item.legKm} km`);
  if (item.legDuration) meta.push(esc(item.legDuration));

  const details = (item.details || []).length
    ? `<ul class="bullets small">${item.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
    : '';

  const booking = item.booking ? renderBookingInline(item.booking) : '';

  return `
    <article class="item${isNow ? ' is-now' : ''}" data-item="${esc(item.id)}">
      <div class="item-time">${esc(fmtTime(item.start, tz) || '—')}</div>
      <div class="item-kind" title="${esc(kindLabel(item.type))}" aria-hidden="true">${kindGlyph(item.type)}</div>
      <div class="item-body">
        <p class="item-title">${esc(item.title)}</p>
        ${meta.length ? `<p class="item-meta">${meta.join(' · ')}</p>` : ''}
        ${details}
        ${booking}
        ${showActions ? itemActions(item) : ''}
      </div>
    </article>`;
}

function renderBookingInline(b) {
  const rows = [];
  if (b.room) rows.push(b.room);
  if (b.checkInWindow) rows.push(`Check-in ${b.checkInWindow}`);
  if (b.checkOutWindow) rows.push(`Check-out ${b.checkOutWindow}`);
  if (b.totalEur) rows.push(`${eur(b.totalEur)}${b.paid ? ' — paid' : ' — due'}`);
  if (b.outstandingChf) rows.push(`${chf(b.outstandingChf)} still to pay`);
  if (!rows.length) return '';
  return `<p class="item-meta small">${rows.map(esc).join(' · ')}</p>`;
}

// ---------------------------------------------------------------------------

export function renderNow(state) {
  const { trip, now } = state;
  const tz = trip.timezone || 'Europe/Zurich';
  const items = [...(trip.items || [])].sort(byStart);

  const current = items.filter((i) => {
    const s = parseDate(i.start);
    const e = parseDate(i.end) || s;
    return s && e && s <= now && now <= e;
  });
  const next = items.filter((i) => {
    const s = parseDate(i.start);
    return s && s > now;
  });

  const tripStart = parseDate(trip.start);
  const countdown = tripStart && tripStart > now
    ? `Departure ${relativeWhen(trip.start, now)}`
    : (parseDate(trip.end) && parseDate(trip.end) >= now ? 'Trip in progress' : 'Trip finished');

  const openDeadlines = (trip.deadlines || [])
    .filter((d) => !d.done)
    .sort((a, b) => (parseDate(a.due) || 0) - (parseDate(b.due) || 0));

  const outstanding = (trip.budget || [])
    .filter((b) => b.status !== 'paid')
    .reduce((s, b) => s + (Number(b.chf) || 0), 0);

  return `
    <section class="card">
      <div class="card-head">
        <h1>${esc(trip.title)}</h1>
      </div>
      <p class="muted">${esc(trip.subtitle || '')}</p>
      <p><span class="chip ok">${esc(countdown)}</span>
         <span class="chip">${esc(fmtDayShort(trip.start, tz))} – ${esc(fmtDayShort(trip.end, tz))}</span>
         <span class="chip">${esc(chf(outstanding))} to pay</span></p>
    </section>

    ${current.length ? `
      <p class="eyebrow">Happening now</p>
      ${current.map((i) => renderItem(i, tz, { now })).join('')}
    ` : ''}

    <p class="eyebrow">Next up</p>
    ${next.length ? next.slice(0, 4).map((i) => renderItem(i, tz, { now })).join('') : EMPTY}

    ${openDeadlines.length ? `
      <p class="eyebrow">Before you go</p>
      <section class="card">
        ${openDeadlines.map((d) => `
          <div class="deadline">
            <div class="deadline-when">${esc(fmtDayShort(d.due, tz))}</div>
            <div>
              <p class="item-title">${severityChip(d.severity)} ${esc(d.title)}</p>
              ${d.detail ? `<p class="item-meta">${esc(d.detail)}</p>` : ''}
              <div class="item-actions">
                <button class="btn small ghost" data-done="${esc(d.id)}" type="button">Mark done</button>
              </div>
            </div>
          </div>`).join('')}
      </section>` : ''}
  `;
}

export function renderPlan(state) {
  const { trip, now } = state;
  const tz = trip.timezone || 'Europe/Zurich';
  const items = [...(trip.items || [])].sort(byStart);
  if (!items.length) return `${EMPTY}<div class="btn-row"><button class="btn primary" data-add-item type="button">Add the first stop</button></div>`;

  const days = new Map();
  for (const item of items) {
    const key = dayKey(item.start, tz) || 'undated';
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(item);
  }

  const todayKey = dayKey(now.toISOString(), tz);
  const blocks = [];
  for (const [key, list] of days) {
    const isToday = key === todayKey;
    const km = list.reduce((s, i) => s + (Number(i.legKm) || 0), 0);
    const sub = [km ? `${km} km` : '', isToday ? 'today' : ''].filter(Boolean).join(' · ');
    blocks.push(`
      <section class="day">
        <div class="day-head">
          <h2>${key === 'undated' ? 'No date yet' : esc(fmtDayLong(`${key}T12:00:00`, tz))}</h2>
          ${sub ? `<span class="day-sub">${esc(sub)}</span>` : ''}
        </div>
        ${list.map((i) => renderItem(i, tz, { now })).join('')}
      </section>`);
  }

  return `
    <div class="btn-row" style="margin-bottom:.9rem">
      <button class="btn primary" data-add-item type="button">Add item</button>
    </div>
    ${blocks.join('')}`;
}

export function renderBookings(state) {
  const { trip } = state;
  const tz = trip.timezone || 'Europe/Zurich';
  const stays = (trip.items || []).filter((i) => i.booking).sort(byStart);
  if (!stays.length) return EMPTY;

  const cards = stays.map((item) => {
    const b = item.booking;
    const rows = [];
    const push = (label, value) => { if (value) rows.push(`<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`); };
    push('Provider', b.provider);
    push('What', b.room);
    push('Who', b.guests);
    push('Dates', `${fmtDayShort(item.start, tz)} → ${fmtDayShort(item.end, tz)}`);
    push('Check-in', b.checkInWindow);
    push('Check-out', b.checkOutWindow);
    if (b.totalEur) push('Total', `${eur(b.totalEur)}${b.paid ? ' (paid)' : ''}`);
    if (b.totalChf) push('Total', `${chf(b.totalChf)}`);
    if (b.paidChf) push('Paid', chf(b.paidChf));
    if (b.outstandingChf) push('Outstanding', chf(b.outstandingChf));
    if (b.dueAtPropertyEur) push('Due at property', eur(b.dueAtPropertyEur));
    push('Payment', b.paymentNote);
    push('Cancellation', b.cancellation);
    push('Address', item.location);
    push('Phone', item.phone);

    const priv = b.private || {};
    const privEntries = Object.entries(priv);
    const privHtml = privEntries.length
      ? `<p class="eyebrow" style="margin-top:.9rem">Private details</p>
         <table class="grid">${privEntries.map(([k, v]) => `
           <tr><th>${esc(k)}</th><td>${v ? `<span class="mono">${esc(v)}</span>` : '<span class="muted small">Locked — import your private file in Setup</span>'}</td></tr>`).join('')}
         </table>`
      : '';

    const breakdown = (b.priceBreakdown || []).length
      ? `<ul class="bullets small">${b.priceBreakdown.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
      : '';

    return `
      <section class="card">
        <div class="card-head"><h2>${esc(item.title)}</h2></div>
        <table class="grid">${rows.join('')}</table>
        ${breakdown}
        ${privHtml}
        <div class="item-actions">${itemActions(item).replace(/^<div class="item-actions">|<\/div>$/g, '')}</div>
      </section>`;
  });

  const contacts = (trip.contacts || []).map((c) => `
    <tr>
      <th>${esc(c.name)}</th>
      <td>${esc(c.role || '')}${c.phone ? ` · <a href="tel:${esc(c.phone.replace(/\s/g, ''))}">${esc(c.phone)}</a>` : ''}${c.web ? ` · <a href="${esc(c.web)}" target="_blank" rel="noopener">web</a>` : ''}${(!c.phone && c.private) ? ' · <span class="muted small">locked</span>' : ''}</td>
    </tr>`).join('');

  return `
    ${cards.join('')}
    <p class="eyebrow">Contacts</p>
    <section class="card"><table class="grid">${contacts}</table></section>`;
}

export function renderMoney(state) {
  const { trip } = state;
  const rows = trip.budget || [];
  if (!rows.length) return EMPTY;

  let due = 0;
  let paid = 0;
  let optional = 0;
  for (const r of rows) {
    const v = Number(r.chf) || 0;
    if (r.status === 'paid') paid += v;
    else if (r.status === 'optional') optional += v;
    else due += v;
  }

  const body = rows.map((r, idx) => `
    <tr>
      <td>
        <strong>${esc(r.label)}</strong>
        ${r.detail ? `<br><span class="muted small">${esc(r.detail)}</span>` : ''}
      </td>
      <td class="num">${esc(chf(r.chf))}</td>
      <td class="num">
        <button class="btn small ghost" data-toggle-paid="${idx}" type="button">
          ${r.status === 'paid' ? 'Paid' : r.status === 'optional' ? 'Optional' : 'Due'}
        </button>
      </td>
    </tr>`).join('');

  return `
    <section class="card">
      <div class="card-head"><h2>Budget</h2><span class="spacer"></span>
        <span class="chip danger">${esc(chf(due))} due</span>
        <span class="chip ok">${esc(chf(paid))} paid</span>
      </div>
      <table class="grid">
        <thead><tr><th>Item</th><th class="num">CHF</th><th class="num">Status</th></tr></thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr class="total"><td>Still to pay</td><td class="num">${esc(chf(due))}</td><td></td></tr>
          ${optional ? `<tr><td class="muted">Optional extras</td><td class="num muted">${esc(chf(optional))}</td><td></td></tr>` : ''}
          <tr><td class="muted">Trip total including paid</td><td class="num muted">${esc(chf(due + paid))}</td><td></td></tr>
        </tfoot>
      </table>
      <p class="muted small">Figures are estimates in Swiss francs. Tap a status to cycle due → paid → optional.</p>
    </section>`;
}

export function renderSummary(state) {
  const { trip, showPrivate } = state;
  const text = buildSummary(trip, { includePrivate: Boolean(showPrivate) });
  return `
    <div class="btn-row" style="margin-bottom:.9rem">
      <button class="btn primary" data-copy-summary type="button">Copy</button>
      <button class="btn" data-share-summary type="button">Share</button>
      <button class="btn ghost" data-print type="button">Print</button>
      <button class="btn ghost" data-toggle-private type="button">${showPrivate ? 'Hide private details' : 'Show private details'}</button>
    </div>
    <pre class="summary" id="summaryText">${esc(text)}</pre>`;
}

export function renderAsk(state) {
  const { trip, chat, settings, online } = state;
  const msgs = chat.length
    ? chat.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}${m.pending ? ' pending' : ''}">${
        esc(m.text).replace(/\n/g, '<br>')
      }</div>`).join('')
    : '<p class="muted">Ask anything about this trip. Answers use your saved trip data.</p>';

  const starters = starterQuestions(trip)
    .map((q) => `<button class="btn small ghost" data-ask="${esc(q)}" type="button">${esc(q)}</button>`)
    .join('');

  const warn = !settings.geminiKey
    ? '<p class="chip warn">No Gemini key yet — add one in Setup. Offline search still works.</p>'
    : (!online ? '<p class="chip warn">Offline — questions are answered from your saved trip text.</p>' : '');

  return `
    ${warn}
    <div class="chat" id="chatLog">${msgs}</div>
    <div class="suggests">${starters}</div>
    <form class="chat-form" id="askForm">
      <textarea id="askInput" rows="1" placeholder="Ask about your trip…" autocomplete="off"></textarea>
      <button class="btn primary" type="submit">Ask</button>
    </form>
    <div class="btn-row" style="margin-top:.6rem">
      <button class="btn small ghost" data-clear-chat type="button">Clear conversation</button>
    </div>`;
}

export function renderSettings(state) {
  const { settings, sync, storage, trip, trips, online } = state;
  const last = sync?.lastSync ? new Date(sync.lastSync).toLocaleString('en-GB') : 'never';
  const tz = trip.timezone || 'Europe/Zurich';

  const tripOptions = (trips || [])
    .map((t) => `<option value="${esc(t.id)}"${t.id === trip.id ? ' selected' : ''}>${esc(t.title)} — ${esc(fmtDateRange(t.start, t.end, tz))}</option>`)
    .join('');

  return `
    <section class="card">
      <div class="card-head"><h2>Trips</h2><span class="spacer"></span>
        <span class="chip">${(trips || []).length} saved</span>
      </div>
      <label class="field">
        <span>Showing</span>
        <select id="activeTrip">${tripOptions}</select>
      </label>
      <p class="muted small">Import another trip file to add it here. Switching keeps every trip on the device, so last year's details stay available.</p>
      <div class="btn-row"><button class="btn danger small" data-delete-trip type="button">Delete this trip</button></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Trip data</h2></div>
      <p class="muted small">Everything is stored on this device. ${esc(storage.backend)} storage${storage.persisted ? ', marked persistent' : ''}.</p>
      <div class="btn-row">
        <button class="btn" data-export type="button">Export backup</button>
        <label class="btn" style="display:inline-flex;align-items:center">
          Import file<input type="file" id="importFile" accept="application/json" hidden>
        </label>
        <button class="btn ghost" data-reload-seed type="button">Reset to shipped trip</button>
      </div>
      <p class="muted small" style="margin-top:.6rem">Import your private file to unlock booking references and PINs, which are deliberately not stored in the public repository.</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>Gemini assistant</h2></div>
      <label class="field">
        <span>API key (stored only in this browser)</span>
        <input type="password" id="geminiKey" value="${esc(settings.geminiKey)}" placeholder="AIza…" autocomplete="off">
      </label>
      <label class="field">
        <span>Model</span>
        <input type="text" id="geminiModel" value="${esc(settings.geminiModel)}" autocomplete="off">
      </label>
      <p class="muted small">Get a key at aistudio.google.com. Anyone with the key can spend your quota, so clear it if you lend the device.</p>
      <div class="btn-row"><button class="btn ghost" data-clear-key type="button">Clear key</button></div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Google sync</h2><span class="spacer"></span>
        <span class="chip${online ? ' ok' : ' warn'}">${online ? 'online' : 'offline'}</span>
      </div>
      <label class="field">
        <span>OAuth client ID</span>
        <input type="text" id="googleClientId" value="${esc(settings.googleClientId)}" placeholder="…apps.googleusercontent.com" autocomplete="off">
      </label>
      <label class="field">
        <span>Gmail search (leave blank for the automatic one)</span>
        <input type="text" id="gmailQuery" value="${esc(settings.gmailQuery)}" placeholder="newer_than:45d (booking OR reservation)" autocomplete="off">
      </label>
      <p class="muted small">Last sync: ${esc(last)}${sync?.lastError ? ` — last error: ${esc(sync.lastError)}` : ''}</p>
      <div class="btn-row">
        <button class="btn primary" data-connect type="button">Connect Google</button>
        <button class="btn ghost" data-disconnect type="button">Disconnect</button>
      </div>
      <p class="muted small" style="margin-top:.6rem">Read-only access to Gmail, Calendar and Drive. Sync proposes changes; it never edits your trip on its own.</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>Appearance</h2></div>
      <label class="field">
        <span>Theme</span>
        <select id="theme">
          <option value="auto"${settings.theme === 'auto' ? ' selected' : ''}>Match device</option>
          <option value="light"${settings.theme === 'light' ? ' selected' : ''}>Light</option>
          <option value="dark"${settings.theme === 'dark' ? ' selected' : ''}>Dark</option>
        </select>
      </label>
      <label class="field">
        <span>Text size</span>
        <select id="textScale">
          <option value="normal"${settings.textScale === 'normal' ? ' selected' : ''}>Normal</option>
          <option value="large"${settings.textScale === 'large' ? ' selected' : ''}>Large</option>
          <option value="xlarge"${settings.textScale === 'xlarge' ? ' selected' : ''}>Extra large</option>
        </select>
      </label>
      <label class="field" style="display:flex;align-items:center;gap:.6rem">
        <input type="checkbox" id="sunlight" style="width:auto;min-height:auto"${settings.sunlight ? ' checked' : ''}>
        <span style="margin:0">Sunlight mode — maximum contrast for bright daylight</span>
      </label>
      <p class="muted small">Trip last changed ${esc(trip.updatedAt ? new Date(trip.updatedAt).toLocaleString('en-GB') : 'unknown')}.</p>
    </section>

    <section class="card">
      <div class="card-head"><h2>Install</h2></div>
      <p class="muted small">iPhone and iPad: Share → Add to Home Screen. Mac Safari: File → Add to Dock. The app then opens full screen and works with no connection.</p>
    </section>`;
}

export function renderInbox(suggestions) {
  const open = (suggestions || []).filter((s) => s.status === 'new');
  if (!open.length) return '';
  return open.map((s) => `
    <article class="card tight suggestion" data-sug="${esc(s.id)}">
      <div class="card-head">
        ${severityChip(s.severity)}
        <span class="spacer"></span>
        <span class="muted small">${esc(s.receivedAt ? relativeWhen(s.receivedAt) : '')}</span>
      </div>
      <p class="item-title">${esc(s.title)}</p>
      ${s.from ? `<p class="item-meta">${esc(s.from)}</p>` : ''}
      ${s.excerpt ? `<p class="item-meta small">${esc(s.excerpt)}</p>` : ''}
      ${(s.facts || []).length ? `<ul class="bullets small">${s.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      ${s.relatedItemTitle ? `<p class="muted small">Looks related to: ${esc(s.relatedItemTitle)}</p>` : ''}
      <div class="item-actions">
        ${s.proposedItem ? `<button class="btn small primary" data-accept="${esc(s.id)}" type="button">Add to plan</button>` : ''}
        ${s.link ? `<a class="btn small ghost" href="${esc(s.link)}" target="_blank" rel="noopener">Open mail</a>` : ''}
        <button class="btn small ghost" data-dismiss="${esc(s.id)}" type="button">Dismiss</button>
      </div>
    </article>`).join('');
}

/** Form used by the add/edit sheet. */
export function renderEditor(item) {
  const v = item || { type: 'event', title: '', start: '', end: '', location: '', details: [] };
  return `
    <label class="field"><span>Title</span>
      <input name="title" value="${esc(v.title)}" required></label>
    <label class="field"><span>Type</span>
      <select name="type">${ITEM_TYPES.map((t) => `<option value="${t}"${v.type === t ? ' selected' : ''}>${esc(kindLabel(t))}</option>`).join('')}</select></label>
    <label class="field"><span>Starts</span>
      <input name="start" type="datetime-local" value="${esc(toLocalInput(v.start))}"></label>
    <label class="field"><span>Ends (optional)</span>
      <input name="end" type="datetime-local" value="${esc(toLocalInput(v.end))}"></label>
    <label class="field"><span>Location</span>
      <input name="location" value="${esc(v.location || '')}"></label>
    <label class="field"><span>Notes (one per line)</span>
      <textarea name="details" rows="4">${esc((v.details || []).join('\n'))}</textarea></label>`;
}

/** datetime-local needs a naive local string, not an ISO instant. */
export function toLocalInput(value) {
  const d = parseDate(value);
  if (!d) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const VIEWS = {
  now: { title: 'Now', render: renderNow },
  plan: { title: 'Plan', render: renderPlan },
  bookings: { title: 'Bookings', render: renderBookings },
  money: { title: 'Money', render: renderMoney },
  summary: { title: 'Summary', render: renderSummary },
  ask: { title: 'Ask', render: renderAsk },
  settings: { title: 'Setup', render: renderSettings },
};
