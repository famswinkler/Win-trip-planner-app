# Review: the Google AI Studio "Trip App", and the data behind it

Date of review: 19 September 2026.

## What I could and could not check

**Could not.** `https://trip-app.ai.studio` is unreachable from this build
environment — the network proxy blocks that domain, so I never saw the running
app or its source. Nothing below is a claim about lines of code I have read.

**Could.** The applet's own record in your Drive, at
`Google AI Studio/applet_access_history.json`:

```json
{ "name": "Trip App",
  "description": "Smart travel companion, integrating your Google Calendar, Gmail confirmations, Google Drive documents, and Gemini AI assistance.",
  "firstAccessTime": "2026-08-17T09:59:42Z",
  "lastAccessTime":  "2026-09-19T03:43:57Z" }
```

And, in full, the real trip data that app is meant to hold: the Booking.com
confirmations in Gmail, the camp invoice and planner in Drive, and the October
entries in your calendar. That is where the useful findings are, so the second
half of this document matters more than the first.

## Structural problems with the hosting model

These follow from *where* the app runs rather than from how it was written.
Each one is worth checking against your version.

1. **A hosted applet needs the network to start.** The page itself is fetched
   from `ai.studio` on every launch. In a Spanish campsite with no signal, or on
   a French motorway with roaming off, an app that must download itself before
   it can show you a check-in time is an app you cannot use. This is the single
   biggest reason to move to something installable.

2. **No install target on iOS.** Unless the applet ships a web app manifest and
   an Apple touch icon, "Add to Home Screen" gives you a bookmark rather than a
   standalone app: Safari chrome stays, the status bar is wrong, and the launch
   is a network round trip.

3. **Google sign-in inside an AI Studio applet is scoped to that applet**, not
   to a client you control. You cannot narrow the scopes, audit the grant, or
   revoke it separately from everything else you have built there.

4. **A browser-side Gemini key is spendable by anyone who reads it.** That is
   true of my build too — the difference is that it should be *stated*, kept out
   of any file that gets committed, and clearable in one tap.

5. **Read-modify-write against live Google data is the dangerous default.** An
   app that reads Gmail and edits your itinerary automatically will, sooner or
   later, parse a date wrong and move a hotel. Suggestions you approve are
   slower and correct.

6. **Nothing survives the session.** Without an explicit local store, edits made
   "on the fly" are lost on reload — which defeats the purpose of editing on the
   road.

## Findings in your actual trip data

These are verified against the source documents, and each one is now surfaced
by the new app.

### 1. The Béziers stay appears three times in your calendar

For 2 October there are three overlapping entries for the same one-night
apartment:

| Entry | Span |
| --- | --- |
| `Stay: Centre Historique … SLEEPNTRIPBEZIERS` | 2 Oct → 4 Oct (all-day) |
| `Centre Historique … SLEEPNTRIPBEZIERS` | 2 Oct 16:00 → 3 Oct 11:00 |
| `Centre Historique - SLEEPNTRIPBEZIERS Booking` | 2 Oct 16:00 → 3 Oct 11:00 |

The booking is **one night**. The all-day entry spanning to 4 October is simply
wrong, and three entries for one stay make the day unreadable. The new app
detects this class of duplicate and offers to flag it.

### 2. Free cancellation on Béziers expires in eleven days

Booking.com: free until **30 September 2026 23:59**, then € 86.72. Nothing in
your calendar or planner mentions this date. It is now a tracked deadline.

### 3. The camp's final invoice has not arrived

The May invoice says the *Schlussrechnung* would follow "im September 2026 vor
Campstart". CHF 600 of roughly CHF 950 is paid; about **CHF 350** is
outstanding. As of today there is no such mail in your inbox. Jonathan is the
named contact.

### 4. The budget is missing about CHF 50 of Avignon costs

Novotel's reception replied on 17 August with details that never reached the
planner's expense table:

- Underground parking **€ 14 per night** — two nights, so € 28.
- Charging at the hotel **€ 15 per charge**.
- City tax **€ 11** is collected *at the property*; the € 392.55 you already
  paid does not include it.

The planner totals about CHF 1,957 outstanding. With these three lines the
figure is closer to CHF 1,970 in total and CHF 1,595 still to pay, which is the
number the new app shows.

### 5. The Avignon car park has a 1.80 m height limit

A Model Y is about 1.62 m, so the car fits. **A roof box almost certainly does
not.** Worth measuring before you load on 1 October rather than discovering it
at the barrier. This is now a pre-departure task.

### 6. Everything you need in an emergency lives only in Gmail

The host's mobile number, the GPS coordinates for a building with no lift, the
PINs that modify the bookings, the cancellation terms — all of it sits in email
threads. That is precisely the data you cannot reach when you most need it. The
new app keeps all of it on the device.

## What changed in the rebuild

| Problem | How the new app handles it |
| --- | --- |
| Needs the network to launch | Installable PWA, service worker, full offline launch |
| No durable storage | IndexedDB with a localStorage fallback, persistence requested |
| Automatic rewrites from email | Sync produces suggestions you accept or dismiss |
| No plain-text fallback | A bullet-point summary you can copy, share or print |
| Credentials in a shared place | PINs and the IBAN stay out of git; imported locally |
| Duplicates and gaps invisible | Duplicate detection, deadlines, corrected budget |
