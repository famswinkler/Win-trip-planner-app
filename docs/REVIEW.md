# Review: the Google AI Studio "Spain Travel Companion"

Reviewed 19 September 2026 against the exported source (React 19, Vite 6,
TypeScript, Tailwind 4, Express, `@google/genai`; about 9,100 lines).

> **Correction.** An earlier draft of this document was written without the
> source, because `trip-app.ai.studio` is blocked from this build environment.
> It speculated that the Gemini key sat in the browser. That was wrong: the app
> declares `MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API` and calls Gemini from
> `src/server/geminiHandler.ts` using `process.env.GEMINI_API_KEY`. The key
> never reaches the client. That part of the design is sound and this rewrite
> replaces the guesswork with what the code actually does.

## Verdict

The app is well presented and considerably more ambitious than I assumed: multi-trip
profiles, a Leaflet map, a packing checklist, a sunlight-readable display mode
and adjustable text sizing. The problems are not cosmetic. Three of them mean
the central promise — your email, documents and tickets gathered in one place,
available offline — cannot work as written, for reasons that are deterministic
rather than intermittent.

---

## Critical

### 1. Every one of your real booking emails is silently discarded

`matchesTripFilters` in `src/utils/campFilters.ts` applies a date window to the
message's **sent date** and compares it against the **travel dates**:

```ts
// campFilters.ts — the email's Date header is tested against the trip window
if (matchesCore) {
  if (strictDateWindow && dateStr && tripStartDate && tripEndDate) {
    return isDateWithinWindow(dateStr, tripStartDate, tripEndDate, 2, 2);
  }
}
```

Confirmations arrive weeks or months before you travel. That is what a
confirmation is. With the shipped config (`strictDateWindow: true`, window
2 – 17 October 2026, ±2 days), I ran your real messages through the app's own
filter:

| Sent | Message | Result |
| --- | --- | --- |
| 17 Aug 2026 | Booking.com — Novotel Avignon confirmed | **dropped** |
| 17 Aug 2026 | Novotel — parking and charging reply | **dropped** |
| 17 Aug 2026 | Booking.com — receipt | **dropped** |
| 3 Jun 2026 | Booking.com — Béziers apartment confirmed | **dropped** |
| 8 May 2026 | Anzahlungsrechnung Herbstcamp 2026 | **dropped** |

Five out of five. The Gmail panel can only ever show mail that happens to
arrive *during* the trip itself.

The same function filters Drive on `modifiedTime`, so your documents go too:
the camp planner (modified 2 Sep), the camp invoice and the Béziers
confirmation PDF (both 3 Jun) are all dropped.

Calendar is unaffected, because there the date tested really is the event's
start. So the app appears to work — the timeline fills — while the two sources
that carry the actual booking details return nothing.

**Fix:** never date-filter a message by when it was sent. Match on dates found
*inside* the content, or drop the date test for mail and Drive entirely and
rely on keywords.

### 2. Nothing works offline, though the UI says it does

There is no service worker, no web app manifest, no IndexedDB and no
`navigator.onLine` anywhere in the source. The only matches for "offline" are
three strings in `ExportBriefingModal.tsx`:

- "Comprehensive offline dossier synthesized from all connected Workspace sources"
- "Ready for offline export"
- "Keep this document handy offline during flights and train rides"

That is label text, not behaviour. Close the tab in a dead zone and the app
cannot reopen — the page itself has to be fetched from the network. Trip data
lives in `localStorage` under `vaya_user_trips_v2`, which is not a durable
store for this: it is capped around 5 MB, it is synchronous, and Safari's
tracking prevention can evict it after seven days without a visit. Coming back
to the app the week before departure and finding it empty is a realistic
outcome.

### 3. Gmail is fetched as metadata only, so no booking details are ever stored

```ts
// googleWorkspace.ts
`...messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
```

Only the subject, sender, date and Gmail's own ~100-character snippet are read.
The body is never fetched. Everything you actually need is in the body: the PIN,
the check-in window, the cancellation terms and deadline, the host's mobile
number, the GPS coordinates, the price breakdown, the Novotel parking height
limit. None of it can reach the app, so none of it can reach the briefing or
the assistant.

---

## Significant

### 4. The OAuth access token is written to localStorage

```ts
localStorage.setItem('g_access_token', resp.access_token);
```

Read scopes on your Gmail, Calendar and Drive, persisted where any script on
the origin can read it and where it survives browser restarts. `isAuthenticated()`
is `!!this.accessToken` with no expiry tracking, so an hour later the app still
believes it is connected while every call returns 401. Keep the token in memory
and record its expiry.

### 5. A failed sign-in silently becomes a fake signed-in state

```ts
if (!window.google?.accounts?.oauth2) {
  const mockToken = 'mock_gworkspace_token_active';
  this.accessToken = mockToken;
  localStorage.setItem('g_access_token', mockToken);
  resolve(mockToken);
}
```

If the Google script is blocked — by a content blocker, a corporate network, or
simply being offline — the app stores a fake token, reports itself connected,
and then fails every request. The honest behaviour is to report that sign-in is
unavailable.

### 6. The assistant is told things that contradict your own planner

`geminiHandler.ts` hard-codes trip facts into the system prompt, and the
charging figure is repeated in nine places across the code:

> "Resort amenities: **11kW Type 2** EV destination chargers"

Your camp planner says the resort has 4 points at **22 kW / 32 A**, and that
charging at the bungalow is **strictly prohibited**. The prompt instead tells
the model to say you can "plug in overnight at the bungalow parking area to
start every day at 100%". The assistant will state this confidently, because
its own instructions assert it.

The prompt also steers food recommendations towards "community paella feasts",
"seafood tapas" and "croquetas de **jamón**" — shellfish and pork, which are
exactly what your planner says to avoid. Nothing in the prompt mentions the
dietary rules or the Friday-evening Sabbath.

### 7. Half the trip does not exist in the app

Searching the source for `Béziers`, `Avignon` and `Novotel` returns nothing.
The app knows only about Tamarit and Tarragona. The outbound stopover, the
two-night return stay, and both Booking.com reservations are absent. So is the
entire French leg of the drive.

The shipped dates are wrong too: `tripStorage.ts` has `startDate: '2026-10-02'`
and `endDate: '2026-10-17'`, and the camp check-out in the sample data is
`2026-10-17T10:00:00`. Your camp runs 3 – 10 October and you are home on the
12th. The 17th is the end of the school holiday, not the trip.
`baseCampOrHotel` reads "Family Premium Bungalow"; the invoice says
**Bungalow NOA**.

---

## Worth fixing

### 8. The booking-reference extractor guesses

```ts
const pnrMatch = snippet.match(/\b([A-Z0-9-]{6,16})\b/);
```

First matching token wins, with no validation. Against your real snippets:

| Message | Extracted |
| --- | --- |
| Novotel confirmation | `6166715237` — correct |
| Béziers confirmation | `5319133560` — correct |
| Camp invoice | `RECHNUNG` — the German word for "invoice" |
| Croatia boarding pass | `ICHE1840` — an API reference, not the booking code |

It is right on Booking.com's format and wrong elsewhere, with nothing to signal
which. Anchor the match to a preceding label such as "Confirmation" or
"Booking number".

### 9. The default Drive query matches almost anything

```ts
query = terms.slice(0, 8).map(t => `name contains '${t}'`).join(' or ');
```

With `CE` and `Camp` among the keywords, `name contains 'CE'` matches
*Rechnung*, *Service*, *Certificate* and any filename containing those two
letters in sequence. The results are noise before the date filter removes them
anyway.

### 10. Synced items get random identifiers

```ts
id: item.id || `cal-${Math.random()}`
```

A new id on every sync means React remounts rows unnecessarily and the app
cannot tell an updated event from a new one. Derive a stable id from the source.

### 11. Smaller things

- `handleCopy` calls `navigator.clipboard.writeText` with no `catch` and no
  fallback. It throws on a non-secure origin and older iOS Safari, and the UI
  still flips to "Copied".
- The briefing is titled "Spain October Trip Briefing" regardless of which trip
  is active, although the app supports Italy and Norway presets.
- It prints `Confirmation Code: N/A` for every row, because calendar sync never
  populates `confirmationCode`.
- `firebase-applet-config.json` carries a live `apiKey`. Firebase web keys are
  designed to be public, so this is not a leaked password — but it only holds
  if your Firestore and Storage rules are restrictive. Worth checking before
  this repository goes anywhere public.
- `userEmail` state defaults to a hard-coded `fam.s.winkler@gmail.com`, and the
  address is also written into the Gemini system prompt.

---

## What the old app does better

Worth keeping, and now carried over into the rebuild:

- **Multi-trip profiles.** Italy and Norway presets alongside Spain, with a
  switcher. This is the "any time I have a trip" requirement and the rebuild
  now has it.
- **Sunlight mode and text-size tiers.** A deliberate high-contrast mode for
  bright daylight, and three font sizes. A genuinely good idea for a screen you
  read at a motorway charger, and now in the rebuild too.
- **Server-side Gemini.** The right call, kept in spirit: the rebuild has no
  server, so it uses a key you hold and can clear, and says so plainly.
- Leaflet map, packing checklist and the briefing export are all sound ideas.
  The briefing in particular is close to what you asked for; it just had almost
  no data to print.

## Summary

| # | Problem | Severity |
| --- | --- | --- |
| 1 | Booking emails and Drive documents filtered out by sent date | Critical |
| 2 | No offline support, while the UI claims it | Critical |
| 3 | Gmail bodies never fetched | Critical |
| 4 | OAuth token in localStorage, no expiry tracking | Significant |
| 5 | Fake "connected" state when sign-in fails | Significant |
| 6 | Prompt contradicts the planner on charging and diet | Significant |
| 7 | Béziers, Avignon and the French leg missing; wrong dates | Significant |
| 8 | Booking reference extracted by guesswork | Moderate |
| 9 | Drive query matches unrelated files | Moderate |
| 10 | Random ids for synced items | Moderate |
| 11 | Clipboard, titles, placeholder fields, config key | Minor |
