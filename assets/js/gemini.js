// Gemini assistant, grounded in the local trip document.
//
// The model is only ever given the offline summary as context, so its answers
// are about *your* trip rather than generic travel advice. It is also told, in
// the system prompt, to say when something is not in the data — a travel app
// that invents a check-in time is worse than one that says it does not know.
//
// The API key lives in this browser only. Anyone with the key can spend your
// quota, so the Setup screen says as much and offers a one-tap way to clear it.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Verified working against the live API on 19 September 2026. */
export const DEFAULT_MODEL = 'gemini-3.6-flash';

/**
 * Models the API now refuses for new keys. A stored setting naming one of
 * these is upgraded on load, so an existing install does not silently break.
 */
export const RETIRED_MODELS = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-exp',
  'gemini-2.5-flash', 'gemini-2.5-pro',
]);

export function resolveModel(name) {
  if (!name || RETIRED_MODELS.has(name)) return DEFAULT_MODEL;
  return name;
}

/**
 * Current Gemini models spend "thinking" tokens out of the same budget as the
 * reply. A short three-bullet answer measured 838 thinking tokens against 88
 * of output, so a 1,200 budget truncates ordinary questions. Hence the
 * generous ceiling.
 */
const MAX_OUTPUT_TOKENS = 4000;

const SYSTEM_PROMPT = `You are the travel assistant inside an offline-first trip app.

Rules:
- Answer only from the TRIP DATA below plus ordinary travel knowledge.
- If the trip data does not contain the answer, say so plainly in one sentence, then offer the closest thing it does contain.
- Never invent booking references, PINs, prices, phone numbers or times.
- Prefer short bullet points. Lead with the answer.
- Use metric units, 24-hour times and European date order.
- The traveller is Swiss, driving a Tesla with a family of four, keeps a Friday-evening to Saturday-evening Sabbath, avoids pork and shellfish, and prefers organic food.
- If asked to change the plan, describe the change clearly; the traveller applies it in the app.`;

export class GeminiError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.retryable = retryable;
  }
}

/**
 * Ask Gemini a question about the trip.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.context Offline trip summary.
 * @param {Array<{role:'user'|'model', text:string}>} opts.history
 * @param {string} opts.question
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} the reply text
 */
export async function askGemini({ apiKey, model = DEFAULT_MODEL, context, history = [], question, signal }) {
  if (!apiKey) throw new GeminiError('Add a Gemini API key in Setup to use the assistant.');
  if (!navigator.onLine) throw new GeminiError('You are offline. Your question is saved and will send when you reconnect.', { retryable: true });

  const contents = [
    ...history.slice(-12).map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    })),
    { role: 'user', parts: [{ text: question }] },
  ];

  const body = {
    systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\n=== TRIP DATA ===\n${context}` }] },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: MAX_OUTPUT_TOKENS, topP: 0.9 },
    safetySettings: [],
  };

  let res;
  try {
    res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new GeminiError('Could not reach Gemini. Check your connection.', { retryable: true });
  }

  if (res.status === 429) throw new GeminiError('Gemini rate limit reached. Try again in a moment.', { retryable: true });
  if (res.status === 503) throw new GeminiError('Gemini is busy right now. Try again in a moment.', { retryable: true });
  if (res.status === 404) {
    throw new GeminiError(`The model "${model}" is not available on this key. Set it to ${DEFAULT_MODEL} in Setup.`);
  }
  if (res.status === 400 || res.status === 403) {
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch { /* no body */ }
    throw new GeminiError(`Gemini rejected the request${detail ? `: ${detail}` : '. Check the API key and model name.'}`);
  }
  if (!res.ok) throw new GeminiError(`Gemini returned ${res.status}.`, { retryable: res.status >= 500 });

  let data;
  try { data = await res.json(); } catch { throw new GeminiError('Gemini sent a reply the app could not read.'); }

  const candidate = data?.candidates?.[0];
  const blocked = data?.promptFeedback?.blockReason || candidate?.finishReason === 'SAFETY';
  if (blocked) throw new GeminiError('Gemini declined to answer that one.');

  const text = (candidate?.content?.parts || [])
    .map((p) => p.text || '')
    .join('')
    .trim();

  if (!text) {
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new GeminiError('The model used its whole budget thinking and produced no answer. Try a narrower question.');
    }
    throw new GeminiError('Gemini returned an empty answer.');
  }
  if (candidate?.finishReason === 'MAX_TOKENS') {
    return `${text}\n\n[cut off — ask a narrower question for the rest]`;
  }
  return text;
}

/** A short list of questions worth asking, drawn from the trip's own content. */
export function starterQuestions(trip) {
  const q = [];
  const open = (trip.deadlines || []).filter((d) => !d.done);
  if (open.length) q.push('What do I still need to do before we leave?');
  if ((trip.items || []).some((i) => i.type === 'charge')) q.push('Summarise the charging stops for the drive down.');
  if ((trip.guides || []).some((g) => /food|diet/i.test(g.title))) q.push('What should I avoid ordering in a Spanish restaurant?');
  if ((trip.budget || []).length) q.push('How much is still left to pay, and to whom?');
  q.push('What is the plan for Saturday?');
  return q.slice(0, 5);
}

/**
 * Cheap local fallback so the Ask tab is not dead weight without the model.
 * @param {string} lead one-line explanation of why this is not an AI answer.
 * @returns {string|null} null when nothing in the trip matches.
 */
export function offlineAnswer(trip, question, lead = 'Searching your saved trip instead of asking the model:') {
  const q = question.toLowerCase();
  const words = q.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length > 3);
  if (!words.length) return null;
  const hits = [];
  for (const item of trip.items || []) {
    const hay = `${item.title} ${item.location || ''} ${(item.details || []).join(' ')}`.toLowerCase();
    const score = words.filter((w) => hay.includes(w)).length;
    if (score) hits.push({ item, score });
  }
  for (const guide of trip.guides || []) {
    for (const b of guide.bullets || []) {
      if (words.some((w) => b.toLowerCase().includes(w))) hits.push({ item: { title: b, location: '' }, score: 1 });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.score - a.score);
  return [
    lead,
    '',
    ...hits.slice(0, 6).map(({ item }) => `- ${item.title}${item.location ? ` \u2014 ${item.location}` : ''}`),
  ].join('\n');
}
