import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_STORAGE_KEY,
  parseIronMsets,
  parseIronHandoffParams,
  doseBurnMult,
  isDuplicateIronExercise,
  readStoredHandoff,
  clearStoredHandoff,
  resolveHandoffSource,
} from "../js/iron-bridge.js";

function memStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function bag({ session, local } = {}) {
  return { sessionStorage: memStore(session), localStorage: memStore(local) };
}

test("parseIronMsets parses id:n pairs and ignores junk", () => {
  assert.deepEqual(parseIronMsets("chest:4,lats:3"), { chest: 4, lats: 3 });
  assert.deepEqual(parseIronMsets(" chest:4 , :0, glutes:2 "), { chest: 4, glutes: 2 });
  assert.deepEqual(parseIronMsets(""), {});
  assert.deepEqual(parseIronMsets(null), {});
});

test("parseIronHandoffParams reads URLSearchParams and query strings", () => {
  const q =
    "iron=1&date=2026-08-03&min=52&name=Iron%20Ledger%20%C2%B7%20Squat&sets=12&dose=MED&muscles=chest,lats,quads&msets=chest:4,lats:3&mode=program&program=bbb_531&label=Squat+day&bw=82&auto=1";
  const fromStr = parseIronHandoffParams("?" + q);
  const fromSp = parseIronHandoffParams(new URLSearchParams(q));
  for (const p of [fromStr, fromSp]) {
    assert.equal(p.fromIron, true);
    assert.equal(p.date, "2026-08-03");
    assert.equal(p.min, 52);
    assert.equal(p.sets, 12);
    assert.equal(p.dose, "med");
    assert.equal(p.auto, true);
    assert.equal(p.mode, "program");
    assert.equal(p.program, "bbb_531");
    assert.equal(p.label, "Squat day");
    assert.equal(p.bwKg, 82);
    assert.deepEqual(p.muscles, ["chest", "lats", "quads"]);
    assert.deepEqual(p.msets, { chest: 4, lats: 3 });
    assert.match(p.name, /Squat/);
  }
  assert.equal(parseIronHandoffParams("from=iron-ledger&min=40").fromIron, true);
  assert.equal(parseIronHandoffParams("from=ironledger").fromIron, true);
  assert.equal(parseIronHandoffParams("min=40").fromIron, false);
  assert.equal(parseIronHandoffParams({ iron: "1", minutes: "30", auto: "true" }).min, 30);
  assert.equal(parseIronHandoffParams({ iron: "1", minutes: "30", auto: "true" }).auto, true);
});

test("doseBurnMult maps rough / oed / default", () => {
  assert.equal(doseBurnMult("rough"), 0.85);
  assert.equal(doseBurnMult("OED"), 1.1);
  assert.equal(doseBurnMult("med"), 1);
  assert.equal(doseBurnMult(""), 1);
  assert.equal(doseBurnMult("other"), 1);
});

test("isDuplicateIronExercise matches iron rows by min or name", () => {
  const existing = [
    { source: "iron_ledger", name: "Iron Ledger · Squat", duration_min: 52 },
    { source: "manual", name: "Walk", duration_min: 52 },
  ];
  assert.equal(isDuplicateIronExercise(existing, { min: 52, name: "Iron Ledger · Squat" }), true);
  assert.equal(isDuplicateIronExercise(existing, { min: 52 }), true);
  assert.equal(isDuplicateIronExercise(existing, { min: 40 }), false);
  assert.equal(
    isDuplicateIronExercise(existing, { name: "Iron Ledger · Squat" }),
    true
  );
  assert.equal(isDuplicateIronExercise([{ name: "Walk", duration_min: 52 }], { min: 52 }), false);
  assert.equal(
    isDuplicateIronExercise(
      [{ name: "Iron Ledger · Press", duration_min: 40 }],
      { min: 40, name: "other" }
    ),
    true
  );
});

test("readStoredHandoff prefers sessionStorage over localStorage", () => {
  const storage = bag({
    session: {
      [HANDOFF_STORAGE_KEY]: JSON.stringify({
        iron: "1",
        min: 50,
        name: "from-session",
        writtenAt: new Date().toISOString(),
      }),
    },
    local: {
      [HANDOFF_STORAGE_KEY]: JSON.stringify({
        iron: "1",
        min: 99,
        name: "from-local",
        writtenAt: new Date().toISOString(),
      }),
    },
  });
  const got = readStoredHandoff(storage);
  assert.equal(got.name, "from-session");
  assert.equal(got.min, 50);
});

test("readStoredHandoff accepts fresh localStorage and rejects stale", () => {
  const fresh = bag({
    local: {
      [HANDOFF_STORAGE_KEY]: JSON.stringify({
        iron: "1",
        min: 44,
        writtenAt: Date.now(),
      }),
    },
  });
  assert.equal(readStoredHandoff(fresh).min, 44);

  const stale = bag({
    local: {
      [HANDOFF_STORAGE_KEY]: JSON.stringify({
        iron: "1",
        min: 44,
        writtenAt: Date.now() - 11 * 60 * 1000,
      }),
    },
  });
  assert.equal(readStoredHandoff(stale), null);
});

test("clearStoredHandoff removes both stores", () => {
  const storage = bag({
    session: { [HANDOFF_STORAGE_KEY]: JSON.stringify({ iron: "1" }) },
    local: { [HANDOFF_STORAGE_KEY]: JSON.stringify({ iron: "1" }) },
  });
  clearStoredHandoff(storage);
  assert.equal(storage.sessionStorage.getItem(HANDOFF_STORAGE_KEY), null);
  assert.equal(storage.localStorage.getItem(HANDOFF_STORAGE_KEY), null);
});

test("resolveHandoffSource: storage wins over URL when present and fresh", () => {
  const url =
    "?iron=1&date=2026-08-01&min=20&name=URL+session&auto=1";
  const storage = bag({
    session: {
      [HANDOFF_STORAGE_KEY]: JSON.stringify({
        iron: "1",
        date: "2026-08-27",
        min: 60,
        name: "Storage session",
        auto: "1",
        writtenAt: new Date().toISOString(),
      }),
    },
  });
  const resolved = resolveHandoffSource({ search: url, storage });
  assert.equal(resolved.source, "storage");
  assert.equal(resolved.params.min, 60);
  assert.equal(resolved.params.date, "2026-08-27");
  assert.match(resolved.params.name, /Storage/);
});

test("resolveHandoffSource: stale localStorage falls back to URL", () => {
  const url = "?iron=1&min=20&name=URL+session&auto=1";
  const storage = bag({
    local: {
      [HANDOFF_STORAGE_KEY]: JSON.stringify({
        iron: "1",
        min: 99,
        name: "Stale",
        writtenAt: Date.now() - 30 * 60 * 1000,
      }),
    },
  });
  const resolved = resolveHandoffSource({ search: url, storage });
  assert.equal(resolved.source, "url");
  assert.equal(resolved.params.min, 20);
});

test("resolveHandoffSource: URL only", () => {
  const resolved = resolveHandoffSource({
    search: "?from=iron-ledger&min=33&auto=1",
    storage: bag(),
  });
  assert.equal(resolved.source, "url");
  assert.equal(resolved.params.fromIron, true);
  assert.equal(resolved.params.min, 33);
});

test("resolveHandoffSource: nothing", () => {
  const resolved = resolveHandoffSource({ search: "", storage: bag() });
  assert.equal(resolved.source, null);
  assert.equal(resolved.params, null);
});
