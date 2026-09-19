// Three-way merge for trips synced between devices.
//
// Kept separate from the network code and free of side effects, because this
// is where sync goes wrong. Two devices edit the same trip, one deletes while
// the other edits, a trip is created on both — each of those has a correct
// answer and a tempting wrong one, and only a pure function can be tested
// exhaustively.
//
// The "base" is a snapshot of each trip's updatedAt as of the last successful
// sync. Without it there is no way to tell "the other device changed this"
// from "this device has not changed it yet", and the merge degenerates into
// last-write-wins, which quietly loses edits.

/** @typedef {{id: string, updatedAt?: string, title?: string}} Trip */

/**
 * @param {object} input
 * @param {Trip[]} input.local   trips on this device
 * @param {Trip[]} input.remote  trips in the Drive app folder
 * @param {Record<string,string>} input.base  id -> updatedAt at last sync
 * @returns {{merged: Trip[], conflicts: Array<object>, deletions: string[]}}
 */
export function mergeTrips({ local = [], remote = [], base = {} }) {
  const byId = (list) => new Map(list.map((t) => [t.id, t]));
  const L = byId(local);
  const R = byId(remote);

  const ids = new Set([...L.keys(), ...R.keys(), ...Object.keys(base)]);
  const merged = [];
  const conflicts = [];
  const deletions = [];

  for (const id of ids) {
    const l = L.get(id);
    const r = R.get(id);
    const b = base[id];
    const known = b !== undefined;

    // "Changed" means different from the last synced state. A missing trip
    // that the base knew about is a deletion, which is also a change.
    const lChanged = l ? l.updatedAt !== b : known;
    const rChanged = r ? r.updatedAt !== b : known;

    if (l && r) {
      if (l.updatedAt === r.updatedAt) {
        merged.push(l);
      } else if (!known) {
        // Same id invented independently on two devices.
        conflicts.push({ id, reason: 'both-created', local: l, remote: r });
        merged.push(newer(l, r));
      } else if (lChanged && rChanged) {
        conflicts.push({ id, reason: 'both-edited', local: l, remote: r });
        merged.push(newer(l, r));
      } else if (lChanged) {
        merged.push(l);
      } else {
        merged.push(r);
      }
      continue;
    }

    if (l && !r) {
      if (!known) {
        merged.push(l);                       // created here, not yet uploaded
      } else if (lChanged) {
        // Deleted on the other device, edited here. Keep the edit and ask:
        // silently discarding someone's work is the one outcome to avoid.
        conflicts.push({ id, reason: 'deleted-remotely-edited-locally', local: l, remote: null });
        merged.push(l);
      } else {
        deletions.push(id);                   // deleted elsewhere, untouched here
      }
      continue;
    }

    if (!l && r) {
      if (!known) {
        merged.push(r);                       // created on the other device
      } else if (rChanged) {
        conflicts.push({ id, reason: 'deleted-locally-edited-remotely', local: null, remote: r });
        merged.push(r);
      } else {
        deletions.push(id);                   // deleted here, untouched elsewhere
      }
      continue;
    }

    // In the base but on neither side: already gone everywhere.
    deletions.push(id);
  }

  merged.sort((a, b2) => String(a.id).localeCompare(String(b2.id)));
  return { merged, conflicts, deletions };
}

function newer(a, b) {
  const ta = Date.parse(a?.updatedAt || '') || 0;
  const tb = Date.parse(b?.updatedAt || '') || 0;
  return tb > ta ? b : a;
}

/**
 * Apply the user's per-conflict choices to a merge result.
 * @param {Trip[]} merged
 * @param {Array<object>} conflicts
 * @param {Record<string,'local'|'remote'>} choices
 */
export function resolveConflicts(merged, conflicts, choices = {}) {
  const out = [...merged];
  for (const c of conflicts) {
    const pick = choices[c.id];
    if (!pick) continue;
    const wanted = pick === 'local' ? c.local : c.remote;
    const idx = out.findIndex((t) => t.id === c.id);
    if (!wanted) {
      // Chose the side that deleted it.
      if (idx >= 0) out.splice(idx, 1);
      continue;
    }
    if (idx >= 0) out[idx] = wanted; else out.push(wanted);
  }
  return out;
}

/** Snapshot to compare against on the next sync. */
export function snapshotBase(trips) {
  const base = {};
  for (const t of trips) base[t.id] = t.updatedAt;
  return base;
}

/** True when the merge produced something different from what this device holds. */
export function differsFrom(trips, merged) {
  if (trips.length !== merged.length) return true;
  const a = snapshotBase(trips);
  const b = snapshotBase(merged);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (a[k] !== b[k]) return true;
  return false;
}
