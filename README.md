# Trip Companion

An offline-first travel app. Everything about a trip — itinerary, bookings,
contacts, money, documents and a Gemini assistant — in one place, on your
iPhone, iPad and Mac, working with no connection at all.

It is plain HTML, CSS and JavaScript. No build step, no framework, no server.

## Why it is built this way

The thing you need most on a trip is the thing you can least rely on having:
a network. So the app stores the whole trip on the device and renders every
screen from that copy. Syncing with Gmail, Calendar and Drive is an optional
extra that runs when you happen to be online, and it never edits your plan on
its own — it proposes changes you accept or dismiss.

See [`docs/REVIEW.md`](docs/REVIEW.md) for the review of the previous AI Studio
app and the data problems found in the October trip.

## Running it

Any static host works. Locally:

```bash
npx http-server -p 8080 -c-1 .
# then open http://127.0.0.1:8080
```

A service worker needs a real origin, so `file://` will not give you offline
support. GitHub Pages is enabled by `.github/workflows/pages.yml` — push to
`main` and the app is served from `https://<user>.github.io/<repo>/`.

### Installing on your devices

- **iPhone / iPad**: open the URL in Safari, then Share → Add to Home Screen.
- **Mac**: Safari → File → Add to Dock, or use it in any browser tab.

Once installed it launches full screen and works in flight mode.

## Using it

| Tab | What it is for |
| --- | --- |
| **Now** | What is happening, what is next, what is still to do before you go |
| **Plan** | The full day-by-day timeline. Tap Edit on anything to change it |
| **Bookings** | Confirmations, check-in windows, cancellation terms, contacts |
| **Money** | The budget. Tap a status to cycle due → paid → optional |
| **Route** | The drive drawn from saved coordinates, plus every stop in order |
| **Packing** | A tickable list that remembers what is already in the car |
| **Summary** | The whole trip as plain bullet points: copy, share or print |
| **Ask** | Gemini, grounded in your trip. Falls back to local search offline |
| **Setup** | Keys, Google sync, import/export, theme |

Editing works offline. Changes are saved to the device the moment you make
them, and there is nothing to "sync back" — this copy is the real one.

## The route map

Drawn as inline SVG from the trip's own coordinates, with no tile library.
Tiles need the network, which is the one thing this app assumes it will not
have; a route diagram works in a tunnel. Coordinates are town-level and exist
to draw the picture — real navigation is handed to Apple or Google Maps through
the link on each stop.

## Optional: Gemini assistant

1. Get a key at [aistudio.google.com](https://aistudio.google.com/apikey).
2. Setup → Gemini assistant → paste the key.

The default model is `gemini-3.6-flash`. Older ids such as `gemini-2.5-flash`
are refused for new keys, so a stored setting naming one is upgraded on load.
Current models spend "thinking" tokens from the same budget as the reply, which
is why the output ceiling is set high.

The key is stored in this browser only and is never committed anywhere. Anyone
with the key can spend your quota, so clear it if you lend the device. The
assistant is given your trip summary as context and is told to say when
something is not in the data rather than invent it.

Without a key the Ask tab still works: it searches your saved trip text.

## Optional: Google sync

Sync reads Gmail, Calendar and Drive to spot things your plan does not know
about yet — a new confirmation, a cancellation, a duplicated calendar entry.

You need your own OAuth client ID:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Gmail**, **Google Calendar** and **Google Drive**
   APIs.
2. Create an **OAuth 2.0 Client ID** of type *Web application*.
3. Add your app's origin (for example `https://<user>.github.io`) to
   **Authorised JavaScript origins**.
4. Paste the client ID into Setup → Google sync → Connect.

Scopes are read-only. The access token lives in memory and dies with the tab.

## Your private data

**This repository is public.** Booking references, PINs and the camp IBAN are
deliberately *not* in `data/trip-spain-2026.json` — those fields ship as
`null` and the Bookings tab shows them as locked.

To put them back, import a private JSON file on your own device:

```
Setup → Trip data → Import file
```

`data/private.example.json` shows the shape. Keep your filled-in copy out of
git; `.gitignore` already excludes `data/private*.json`.

## Syncing your iPhone, iPad and Mac

Setup → Sync across your devices. Trips are mirrored through a private folder
in your Google Drive that only this app can see. It does not show up among your
files, and the `drive.appdata` scope gives the app no access to anything else
in Drive.

The device keeps the real copy; Drive is only the meeting point. Everything
still works with no connection, and the next sync catches up.

Merging is three-way, against a snapshot of each trip taken at the last
successful sync. That snapshot is what lets the app tell "the other device
changed this" from "I have not changed it yet" — without it, sync degenerates
into last-write-wins and quietly loses edits. If the same trip changed in two
places, nothing is uploaded and the app asks which to keep. A trip deleted on
one device but edited on the other is always kept, not deleted.

You still need the OAuth client ID from the section above, and you must
reconnect once after enabling this so Google grants the extra scope.

Export and import remain as the manual fallback, which needs no connection to
Google at all.

## More than one trip

The app holds as many trips as you like. Copy `data/trip-spain-2026.json`, edit
it, give it a new `id`, and import it through Setup → Trips. Switch between
them with the picker; every trip stays on the device, so last year's details
remain available. Importing a file whose `id` already exists updates that trip
in place rather than adding a duplicate.

Required fields are `title`, `start`, `end` and an `items` array where each
item has an `id`, a `title` and a `start`.

## Reading it outdoors

Setup → Appearance has a **sunlight mode**: black on white, heavier borders,
no shadows, for reading at a motorway charger in direct sun. Text size has
three steps on top of whatever your device is set to.

## Tests

```bash
node --test 'tests/*.test.mjs'
```

- `app.test.mjs` — data model, HTML escaping, the summary generator, email and
  calendar parsing, and the rule that no credentials appear in the seed.
- `merge.test.mjs` — the three-way sync merge: edits on one side, edits on
  both, creations, deletions, and delete-versus-edit.
- `drivesync.test.mjs` — the Drive transport against a mock app folder,
  including a two-device round trip and every error path.
