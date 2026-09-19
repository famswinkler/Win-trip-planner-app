import assert from 'node:assert/strict';
import { test } from 'node:test';
import { differsFrom, mergeTrips, resolveConflicts, snapshotBase } from '../assets/js/merge.js';

const trip = (id, updatedAt, title = id) => ({ id, updatedAt, title, items: [] });

test('unchanged on both sides keeps the trip and reports nothing', () => {
  const t = trip('a', '2026-09-01T00:00:00Z');
  const r = mergeTrips({ local: [t], remote: [t], base: { a: t.updatedAt } });
  assert.equal(r.merged.length, 1);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.deletions, []);
});

test('edited locally only wins', () => {
  const r = mergeTrips({
    local: [trip('a', '2026-09-02T00:00:00Z', 'newer')],
    remote: [trip('a', '2026-09-01T00:00:00Z', 'older')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(r.merged[0].title, 'newer');
  assert.deepEqual(r.conflicts, []);
});

test('edited remotely only wins, even when its timestamp is older', () => {
  // The other device edited; this one did not. Base equals the LOCAL value,
  // so local is unchanged and must not clobber the remote edit.
  const r = mergeTrips({
    local: [trip('a', '2026-09-01T00:00:00Z', 'stale')],
    remote: [trip('a', '2026-09-05T00:00:00Z', 'their edit')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(r.merged[0].title, 'their edit');
  assert.deepEqual(r.conflicts, []);
});

test('edited on both sides is a conflict, and the newer side is provisional', () => {
  const r = mergeTrips({
    local: [trip('a', '2026-09-03T00:00:00Z', 'mine')],
    remote: [trip('a', '2026-09-04T00:00:00Z', 'theirs')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].reason, 'both-edited');
  assert.equal(r.merged[0].title, 'theirs');
});

test('created locally is kept and not mistaken for a remote deletion', () => {
  const r = mergeTrips({ local: [trip('new', '2026-09-03T00:00:00Z')], remote: [], base: {} });
  assert.equal(r.merged.length, 1);
  assert.deepEqual(r.deletions, []);
  assert.deepEqual(r.conflicts, []);
});

test('created remotely is adopted', () => {
  const r = mergeTrips({ local: [], remote: [trip('new', '2026-09-03T00:00:00Z')], base: {} });
  assert.equal(r.merged.length, 1);
  assert.deepEqual(r.deletions, []);
});

test('the same id created independently on both devices is a conflict', () => {
  const r = mergeTrips({
    local: [trip('dup', '2026-09-01T00:00:00Z', 'mine')],
    remote: [trip('dup', '2026-09-02T00:00:00Z', 'theirs')],
    base: {},
  });
  assert.equal(r.conflicts[0].reason, 'both-created');
});

test('deleted remotely and untouched locally propagates the delete', () => {
  const r = mergeTrips({
    local: [trip('a', '2026-09-01T00:00:00Z')],
    remote: [],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.deletions, ['a']);
  assert.deepEqual(r.conflicts, []);
});

test('deleted locally and untouched remotely propagates the delete', () => {
  const r = mergeTrips({
    local: [],
    remote: [trip('a', '2026-09-01T00:00:00Z')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.deletions, ['a']);
});

test('deleted on one side but edited on the other never loses the edit', () => {
  const edited = trip('a', '2026-09-09T00:00:00Z', 'edited here');
  const r = mergeTrips({ local: [edited], remote: [], base: { a: '2026-09-01T00:00:00Z' } });
  assert.equal(r.conflicts[0].reason, 'deleted-remotely-edited-locally');
  assert.equal(r.merged[0].title, 'edited here');
  assert.deepEqual(r.deletions, []);

  const r2 = mergeTrips({
    local: [], remote: [trip('a', '2026-09-09T00:00:00Z', 'edited there')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(r2.conflicts[0].reason, 'deleted-locally-edited-remotely');
  assert.equal(r2.merged[0].title, 'edited there');
});

test('gone from both sides is simply dropped', () => {
  const r = mergeTrips({ local: [], remote: [], base: { a: '2026-09-01T00:00:00Z' } });
  assert.deepEqual(r.merged, []);
  assert.deepEqual(r.deletions, ['a']);
});

test('several trips merge independently', () => {
  // 'mine' and 'theirs' are absent from the base: each was created on one
  // device since the last sync, so neither is a deletion.
  const r = mergeTrips({
    local: [trip('keep', '2026-09-01T00:00:00Z'), trip('mine', '2026-09-05T00:00:00Z'), trip('conf', '2026-09-05T00:00:00Z', 'L')],
    remote: [trip('keep', '2026-09-01T00:00:00Z'), trip('theirs', '2026-09-06T00:00:00Z'), trip('conf', '2026-09-06T00:00:00Z', 'R')],
    base: { keep: '2026-09-01T00:00:00Z', conf: '2026-09-01T00:00:00Z' },
  });
  assert.deepEqual(r.merged.map((t) => t.id).sort(), ['conf', 'keep', 'mine', 'theirs']);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].id, 'conf');
  assert.deepEqual(r.deletions, []);
});

test('a locally created trip present in the base reads as deleted elsewhere', () => {
  // The distinction the base exists to make: same local state, opposite meaning.
  const inBase = mergeTrips({
    local: [trip('a', '2026-09-05T00:00:00Z')], remote: [],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(inBase.conflicts[0].reason, 'deleted-remotely-edited-locally');

  const notInBase = mergeTrips({
    local: [trip('a', '2026-09-05T00:00:00Z')], remote: [], base: {},
  });
  assert.deepEqual(notInBase.conflicts, []);
  assert.equal(notInBase.merged.length, 1);
});

test('conflict resolution honours the choice, including choosing a deletion', () => {
  const { merged, conflicts } = mergeTrips({
    local: [trip('a', '2026-09-03T00:00:00Z', 'mine')],
    remote: [trip('a', '2026-09-04T00:00:00Z', 'theirs')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(resolveConflicts(merged, conflicts, { a: 'local' })[0].title, 'mine');
  assert.equal(resolveConflicts(merged, conflicts, { a: 'remote' })[0].title, 'theirs');

  const del = mergeTrips({ local: [trip('a', '2026-09-09T00:00:00Z')], remote: [], base: { a: '2026-09-01T00:00:00Z' } });
  assert.deepEqual(resolveConflicts(del.merged, del.conflicts, { a: 'remote' }), []);
});

test('an unresolved conflict leaves the provisional pick in place', () => {
  const { merged, conflicts } = mergeTrips({
    local: [trip('a', '2026-09-03T00:00:00Z', 'mine')],
    remote: [trip('a', '2026-09-04T00:00:00Z', 'theirs')],
    base: { a: '2026-09-01T00:00:00Z' },
  });
  assert.equal(resolveConflicts(merged, conflicts, {})[0].title, 'theirs');
});

test('merging is idempotent once the base is updated', () => {
  const local = [trip('a', '2026-09-02T00:00:00Z')];
  const remote = [trip('a', '2026-09-01T00:00:00Z')];
  const first = mergeTrips({ local, remote, base: { a: '2026-09-01T00:00:00Z' } });
  const base = snapshotBase(first.merged);
  const second = mergeTrips({ local: first.merged, remote: first.merged, base });
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(second.deletions, []);
  assert.deepEqual(second.merged, first.merged);
});

test('differsFrom spots additions, removals and edits', () => {
  const a = [trip('x', '1')];
  assert.equal(differsFrom(a, [trip('x', '1')]), false);
  assert.equal(differsFrom(a, [trip('x', '2')]), true);
  assert.equal(differsFrom(a, []), true);
  assert.equal(differsFrom(a, [trip('x', '1'), trip('y', '1')]), true);
});

test('a trip with no updatedAt does not crash the merge', () => {
  const r = mergeTrips({ local: [{ id: 'a' }], remote: [{ id: 'a' }], base: {} });
  assert.equal(r.merged.length, 1);
  assert.deepEqual(r.conflicts, []);
});
