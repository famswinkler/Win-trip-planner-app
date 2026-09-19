// Application controller: routing, state, events, sync.

import * as store from './store.js';
import * as google from './google.js';
import { askGemini, GeminiError, offlineAnswer } from './gemini.js';
import { defaultGmailQuery, suggestionsFromCalendar, suggestionsFromMail } from './ingest.js';
import { buildAiContext, buildSummary } from './summary.js';
import { renderEditor, renderInbox, VIEWS } from './views.js';
import { $, clone, copyText, fmtDateRange, parseDate, uid } from './util.js';

const SEED_URL = 'data/trip-spain-2026.json';
const ROUTES = Object.keys(VIEWS);

const state = {
  route: 'now',
  trip: null,
  settings: { ...store.DEFAULT_SETTINGS },
  chat: [],
  suggestions: [],
  sync: { lastSync: null, lastError: null },
  seenMail: [],
  online: navigator.onLine,
  now: new Date(),
  showPrivate: false,
  syncing: false,
  storage: { backend: 'idb', persisted: false },
};

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  state.settings = await store.loadSettings();
  applyTheme(state.settings.theme);

  state.trip = await store.loadTrip();
  if (!state.trip) state.trip = await loadSeed();

  state.chat = await store.loadChat();
  state.suggestions = await store.loadSuggestions();
  state.sync = await store.loadSyncState();
  state.seenMail = await store.get(store.KEYS.seenMail, []);
  state.storage = {
    backend: store.storageBackend(),
    persisted: await store.requestPersistence(),
  };

  $('#boot').hidden = true;
  $('#app').hidden = false;

  wireChrome();
  route(locationRoute() || 'now');
  registerServiceWorker();

  // Keep "now" fresh so the current-item highlight and countdowns stay honest.
  setInterval(() => {
    state.now = new Date();
    if (state.route === 'now') render();
  }, 60_000);

  if (state.settings.autoSync && state.online && state.settings.googleClientId) {
    // Silent attempt; a failure here must never block the UI.
    syncAll({ silent: true }).catch(() => {});
  }
}

async function loadSeed() {
  try {
    const res = await fetch(SEED_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const trip = await res.json();
    await store.saveTrip(trip);
    return trip;
  } catch {
    // An empty but valid trip beats a blank screen.
    return {
      schemaVersion: 1,
      id: uid('trip'),
      title: 'New trip',
      start: new Date().toISOString().slice(0, 10),
      end: new Date().toISOString().slice(0, 10),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Zurich',
      items: [], budget: [], deadlines: [], contacts: [], guides: [],
    };
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// has no service worker scope; skip rather than throwing on open.
  if (location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    toast('Offline mode unavailable on this connection.');
  });
}

// ---------------------------------------------------------------------------
// Routing and rendering

function locationRoute() {
  const hash = location.hash.replace('#', '');
  return ROUTES.includes(hash) ? hash : null;
}

function route(name) {
  state.route = ROUTES.includes(name) ? name : 'now';
  if (location.hash !== `#${state.route}`) {
    history.replaceState(null, '', `#${state.route}`);
  }
  for (const btn of document.querySelectorAll('[data-route]')) {
    const active = btn.dataset.route === state.route;
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  }
  render();
  $('#main').scrollTo?.({ top: 0 });
}

function render() {
  const view = VIEWS[state.route];
  $('#view').innerHTML = view.render(state);
  const inbox = $('#inbox');
  const html = renderInbox(state.suggestions);
  inbox.innerHTML = html;
  inbox.hidden = !html;
  $('#tripTitle').textContent = state.trip.title;
  $('#tripDates').textContent = fmtDateRange(state.trip.start, state.trip.end, state.trip.timezone);
  updateNetBadge();
  if (state.route === 'ask') {
    const log = $('#chatLog');
    if (log) log.scrollTop = log.scrollHeight;
  }
}

function updateNetBadge() {
  const badge = $('#netBadge');
  if (state.syncing) {
    badge.textContent = 'syncing';
    badge.className = 'badge syncing';
  } else if (state.online) {
    badge.textContent = 'online';
    badge.className = 'badge online';
  } else {
    badge.textContent = 'offline';
    badge.className = 'badge';
  }
  $('#btnSync').disabled = !state.online || state.syncing;
}

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------------------------------------------------------------------
// Chrome wiring

function wireChrome() {
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('change', onChange);
  window.addEventListener('hashchange', () => route(locationRoute() || 'now'));
  window.addEventListener('online', () => { state.online = true; updateNetBadge(); });
  window.addEventListener('offline', () => { state.online = false; updateNetBadge(); });
  $('#btnSync').addEventListener('click', () => syncAll({ silent: false }));
}

async function onClick(event) {
  const t = event.target.closest('[data-route],[data-copy],[data-edit],[data-done],[data-add-item],[data-copy-summary],[data-share-summary],[data-print],[data-toggle-private],[data-toggle-paid],[data-ask],[data-clear-chat],[data-export],[data-reload-seed],[data-clear-key],[data-connect],[data-disconnect],[data-accept],[data-dismiss]');
  if (!t) return;
  const d = t.dataset;

  if (d.route) { route(d.route); return; }

  if (d.copy) {
    event.preventDefault();
    toast(await copyText(d.copy) ? 'Copied' : 'Could not copy');
    return;
  }

  if (d.edit) { openEditor(d.edit); return; }
  if ('addItem' in d) { openEditor(null); return; }

  if (d.done) {
    const dl = (state.trip.deadlines || []).find((x) => x.id === d.done);
    if (dl) { dl.done = true; await persistTrip(); toast('Marked done'); }
    return;
  }

  if ('copySummary' in d) {
    const text = buildSummary(state.trip, { includePrivate: state.showPrivate });
    toast(await copyText(text) ? 'Summary copied' : 'Could not copy');
    return;
  }

  if ('shareSummary' in d) {
    const text = buildSummary(state.trip, { includePrivate: state.showPrivate });
    if (navigator.share) {
      try { await navigator.share({ title: state.trip.title, text }); } catch { /* cancelled */ }
    } else {
      toast(await copyText(text) ? 'Copied — sharing is not available here' : 'Could not share');
    }
    return;
  }

  if ('print' in d) { window.print(); return; }

  if ('togglePrivate' in d) { state.showPrivate = !state.showPrivate; render(); return; }

  if (d.togglePaid !== undefined) {
    const row = state.trip.budget?.[Number(d.togglePaid)];
    if (row) {
      row.status = row.status === 'paid' ? 'optional' : row.status === 'optional' ? 'due' : 'paid';
      await persistTrip();
    }
    return;
  }

  if (d.ask) { await ask(d.ask); return; }

  if ('clearChat' in d) {
    state.chat = [];
    await store.saveChat(state.chat);
    render();
    return;
  }

  if ('export' in d) { await exportBackup(); return; }

  if ('reloadSeed' in d) {
    if (!confirm('Replace the trip on this device with the version shipped in the app? Your edits will be lost.')) return;
    state.trip = await loadSeed();
    render();
    toast('Trip reset');
    return;
  }

  if ('clearKey' in d) {
    state.settings = await store.saveSettings({ geminiKey: '' });
    render();
    toast('Gemini key cleared');
    return;
  }

  if ('connect' in d) { await connectGoogle(); return; }

  if ('disconnect' in d) {
    google.signOut();
    toast('Disconnected from Google');
    return;
  }

  if (d.accept) { await acceptSuggestion(d.accept); return; }

  if (d.dismiss) {
    const s = state.suggestions.find((x) => x.id === d.dismiss);
    if (s) { s.status = 'dismissed'; await store.saveSuggestions(state.suggestions); render(); }
    return;
  }
}

async function onSubmit(event) {
  if (event.target.id === 'askForm') {
    event.preventDefault();
    const input = $('#askInput');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    await ask(question);
  }
}

async function onChange(event) {
  const el = event.target;
  if (el.id === 'theme') {
    state.settings = await store.saveSettings({ theme: el.value });
    applyTheme(el.value);
    return;
  }
  if (['geminiKey', 'geminiModel', 'googleClientId', 'gmailQuery'].includes(el.id)) {
    state.settings = await store.saveSettings({ [el.id]: el.value.trim() });
    toast('Saved');
    return;
  }
  if (el.id === 'importFile' && el.files?.[0]) {
    try {
      const text = await el.files[0].text();
      state.trip = await store.importBundle(JSON.parse(text));
      state.showPrivate = true;
      render();
      toast('Trip imported');
    } catch (err) {
      toast(err.message || 'Could not read that file');
    }
    el.value = '';
  }
}

// ---------------------------------------------------------------------------
// Editing

let editingId = null;

function openEditor(itemId) {
  editingId = itemId;
  const item = itemId ? (state.trip.items || []).find((i) => i.id === itemId) : null;
  $('#editorTitle').textContent = item ? 'Edit item' : 'Add item';
  $('#editorBody').innerHTML = renderEditor(item);
  $('#editorDelete').hidden = !item;
  const dialog = $('#editor');
  dialog.showModal();
  dialog.addEventListener('close', onEditorClose, { once: true });
}

async function onEditorClose() {
  const dialog = $('#editor');
  const action = dialog.returnValue;
  const form = $('#editorForm');
  if (action === 'save') {
    const data = new FormData(form);
    const details = String(data.get('details') || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const patch = {
      title: String(data.get('title') || '').trim() || 'Untitled',
      type: String(data.get('type') || 'event'),
      start: fromLocalInput(data.get('start')),
      end: fromLocalInput(data.get('end')),
      location: String(data.get('location') || '').trim(),
      details,
    };
    state.trip.items = state.trip.items || [];
    if (editingId) {
      const idx = state.trip.items.findIndex((i) => i.id === editingId);
      if (idx >= 0) state.trip.items[idx] = { ...state.trip.items[idx], ...patch };
    } else {
      state.trip.items.push({ id: uid('item'), ...patch });
    }
    await persistTrip();
    toast('Saved');
  } else if (action === 'delete' && editingId) {
    if (confirm('Delete this item?')) {
      state.trip.items = (state.trip.items || []).filter((i) => i.id !== editingId);
      await persistTrip();
      toast('Deleted');
    }
  }
  editingId = null;
}

/** A naive datetime-local value is local wall time; make it a real instant. */
function fromLocalInput(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

async function persistTrip() {
  await store.saveTrip(state.trip);
  render();
}

// ---------------------------------------------------------------------------
// Assistant

async function ask(question) {
  state.chat.push({ role: 'user', text: question });
  state.chat.push({ role: 'model', text: 'Thinking…', pending: true });
  render();

  const finish = async (text) => {
    state.chat = state.chat.filter((m) => !m.pending);
    state.chat.push({ role: 'model', text });
    await store.saveChat(state.chat);
    render();
  };

  if (!state.online || !state.settings.geminiKey) {
    const offline = !state.online;
    const lead = offline
      ? 'You are offline, so this is a plain search of your saved trip rather than an AI answer:'
      : 'No Gemini key yet (add one in Setup). Searching your saved trip instead:';
    const local = offlineAnswer(state.trip, question, lead);
    await finish(local || (offline
      ? 'You are offline and nothing in the saved trip matches that. Try again when you have a connection.'
      : 'No Gemini key yet — add one in Setup. Nothing in the saved trip matches that either.'));
    return;
  }

  try {
    const reply = await askGemini({
      apiKey: state.settings.geminiKey,
      model: state.settings.geminiModel,
      context: buildAiContext(state.trip),
      history: state.chat.filter((m) => !m.pending).slice(0, -1),
      question,
    });
    await finish(reply);
  } catch (err) {
    const note = err instanceof GeminiError ? err.message : 'The assistant failed.';
    const fallback = offlineAnswer(state.trip, question, 'From your saved trip:');
    await finish(fallback ? `${note}\n\n${fallback}` : note);
  }
}

// ---------------------------------------------------------------------------
// Sync

async function connectGoogle() {
  try {
    await google.authorize(state.settings.googleClientId, { interactive: true });
    toast('Connected to Google');
    await syncAll({ silent: false });
  } catch (err) {
    toast(err.message || 'Could not connect');
  }
}

async function syncAll({ silent }) {
  if (state.syncing) return;
  if (!state.online) { if (!silent) toast('You are offline'); return; }
  if (!state.settings.googleClientId) {
    if (!silent) toast('Add your Google OAuth client ID in Setup');
    return;
  }

  state.syncing = true;
  updateNetBadge();
  const errors = [];
  let added = 0;

  try {
    await google.authorize(state.settings.googleClientId, { interactive: !silent });

    const trip = state.trip;
    const start = parseDate(trip.start);
    const end = parseDate(trip.end);
    const timeMin = new Date((start?.getTime() || Date.now()) - 3 * 86400000).toISOString();
    const timeMax = new Date((end?.getTime() || Date.now()) + 3 * 86400000).toISOString();

    // Calendar
    try {
      const events = await google.fetchCalendarEvents({ timeMin, timeMax });
      const fresh = suggestionsFromCalendar(events, trip);
      added += mergeSuggestions(fresh);
    } catch (err) { errors.push(`Calendar: ${err.message}`); }

    // Gmail
    try {
      const query = state.settings.gmailQuery || defaultGmailQuery(trip);
      const mail = await google.fetchMail(query, { max: 15 });
      const fresh = suggestionsFromMail(mail, trip, state.seenMail);
      added += mergeSuggestions(fresh);
      state.seenMail = [...new Set([...state.seenMail, ...mail.map((m) => m.id)])].slice(-400);
      await store.set(store.KEYS.seenMail, state.seenMail);
    } catch (err) { errors.push(`Gmail: ${err.message}`); }

    state.sync = {
      lastSync: new Date().toISOString(),
      lastError: errors.length ? errors.join(' · ') : null,
    };
    await store.saveSyncState(state.sync);

    if (!silent || added) {
      toast(added ? `${added} new thing${added === 1 ? '' : 's'} to review` : 'Up to date');
    }
  } catch (err) {
    state.sync = { ...state.sync, lastError: err.message };
    await store.saveSyncState(state.sync);
    if (!silent) toast(err.message || 'Sync failed');
  } finally {
    state.syncing = false;
    render();
  }
}

/** Add suggestions we have not already shown, keyed by their source id. */
function mergeSuggestions(fresh) {
  const seen = new Set(state.suggestions.map((s) => `${s.source?.kind}:${s.source?.id}`));
  const add = fresh.filter((s) => !seen.has(`${s.source?.kind}:${s.source?.id}`));
  if (add.length) {
    state.suggestions = [...add, ...state.suggestions];
    store.saveSuggestions(state.suggestions);
  }
  return add.length;
}

async function acceptSuggestion(id) {
  const s = state.suggestions.find((x) => x.id === id);
  if (!s?.proposedItem) return;
  state.trip.items = state.trip.items || [];
  state.trip.items.push({ id: uid('item'), ...clone(s.proposedItem) });
  s.status = 'accepted';
  await store.saveSuggestions(state.suggestions);
  await persistTrip();
  toast('Added to your plan');
}

// ---------------------------------------------------------------------------

async function exportBackup() {
  const bundle = await store.exportAll();
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.trip.id || 'trip'}-backup.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Backup downloaded');
}

boot().catch((err) => {
  $('#boot').innerHTML = `<p>Something went wrong starting the app.<br><small>${String(err?.message || err)}</small></p>`;
});
