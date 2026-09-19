// Small helpers shared by every view. No dependencies, no build step.

/** Escape text for safe insertion into HTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Escape text for use inside an HTML attribute value. */
export const escAttr = esc;

export function $(selector, root = document) { return root.querySelector(selector); }
export function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

/**
 * Parse an ISO timestamp. Returns null for missing or unparseable values so
 * callers never end up rendering "Invalid Date".
 */
export function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const LOCALE = 'en-GB';

/** Calendar date key (YYYY-MM-DD) in the trip's timezone. */
export function dayKey(value, timeZone) {
  const d = parseDate(value);
  if (!d) return '';
  // en-CA gives an ISO-shaped date, which sorts correctly as a string.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function fmtTime(value, timeZone) {
  const d = parseDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

export function fmtDayLong(value, timeZone) {
  const d = parseDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

export function fmtDayShort(value, timeZone) {
  const d = parseDate(value);
  if (!d) return '';
  return new Intl.DateTimeFormat(LOCALE, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
}

export function fmtDateRange(startValue, endValue, timeZone) {
  const a = fmtDayShort(startValue, timeZone);
  const b = fmtDayShort(endValue, timeZone);
  if (!a) return '';
  return b && b !== a ? `${a} – ${b}` : a;
}

/** Whole days between now and a target, rounded towards zero. */
export function daysUntil(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return null;
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

export function relativeWhen(value, now = new Date()) {
  const d = parseDate(value);
  if (!d) return '';
  const ms = d.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const past = ms < 0;
  const mins = Math.round(abs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return past ? `${mins} min ago` : `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return past ? `${hours} h ago` : `in ${hours} h`;
  const days = Math.round(hours / 24);
  return past ? `${days} days ago` : `in ${days} days`;
}

/** Deep-ish clone that works for the plain JSON we store. */
export function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function uid(prefix = 'i') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Stable sort by start time; undated items sink to the bottom. */
export function byStart(a, b) {
  const da = parseDate(a.start);
  const db = parseDate(b.start);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return 0;
}

/**
 * Map links that work without a network connection on the device itself:
 * Apple Maps on iOS/macOS, Google Maps everywhere else.
 */
export function mapLinks(item) {
  const label = item.location || item.title || '';
  const q = item.coords
    ? `${item.coords.lat},${item.coords.lon}`
    : label;
  if (!q) return null;
  return {
    apple: `https://maps.apple.com/?q=${encodeURIComponent(label || q)}&ll=${item.coords ? `${item.coords.lat},${item.coords.lon}` : ''}`,
    google: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    coords: item.coords ? `${item.coords.lat.toFixed(5)}, ${item.coords.lon.toFixed(5)}` : null,
  };
}

const KIND_GLYPH = {
  drive: '→', charge: '⚡', stay: '⌂', event: '★',
  meal: '●', shop: '■', task: '✓', info: 'ℹ',
};
export function kindGlyph(type) { return KIND_GLYPH[type] || '•'; }

const KIND_LABEL = {
  drive: 'Drive', charge: 'Charge', stay: 'Stay', event: 'Event',
  meal: 'Food', shop: 'Shopping', task: 'To do', info: 'Info',
};
export function kindLabel(type) { return KIND_LABEL[type] || 'Item'; }

export const ITEM_TYPES = Object.keys(KIND_LABEL);

/** Copy to clipboard with a fallback for older WebKit. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function debounce(fn, ms = 300) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Money helper: renders whole francs, since every figure we hold is an estimate. */
export function chf(amount) {
  return `CHF ${Math.round(Number(amount) || 0).toLocaleString('de-CH')}`;
}

export function eur(amount) {
  return `€ ${(Number(amount) || 0).toLocaleString('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
