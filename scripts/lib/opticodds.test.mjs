// Verifies the OpticOdds client's request construction, batching, retry and
// pagination behaviour against a stub fetch — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpticOddsClient,
  OpticOddsError,
  buildQuery,
  chunk,
  unwrapData,
  MAX_SPORTSBOOKS_PER_REQUEST,
  MAX_FIXTURES_PER_REQUEST,
} from "./opticodds.mjs";

const QUIET = { warn() {}, log() {} };
// A rate that never actually throttles, so tests stay fast.
const FAST = { requests: 1000, perMs: 10 };

// Stub fetch that records calls and replays a queue of scripted responses.
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url) => {
    calls.push(url);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.status === undefined || (next.status >= 200 && next.status < 300),
      status: next.status ?? 200,
      headers: { get: (h) => next.headers?.[h.toLowerCase()] ?? null },
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

const client = (fetchImpl, opts = {}) =>
  new OpticOddsClient({ apiKey: "test-key", fetchImpl, logger: QUIET, rate: FAST, ...opts });

// ---- Query construction ------------------------------------------------------
test("array params become repeated query params, not comma-joined", () => {
  // This is a hard OpticOdds requirement — sportsbook=A&sportsbook=B.
  // URLSearchParams would render an array as "A,B" if handed one directly.
  const qs = buildQuery({ sportsbook: ["DraftKings", "FanDuel"], league: "nfl" });
  assert.equal(qs, "sportsbook=DraftKings&sportsbook=FanDuel&league=nfl");
  assert.ok(!qs.includes(","));
});

test("empty and nullish params are omitted", () => {
  assert.equal(buildQuery({ a: 1, b: null, c: undefined, d: "", e: [] }), "a=1");
  assert.equal(buildQuery({ list: ["x", null, "", "y"] }), "list=x&list=y");
  assert.equal(buildQuery(null), "");
});

test("params are URL-encoded", () => {
  assert.equal(buildQuery({ market: "Player Passing Yards" }), "market=Player+Passing+Yards");
});

// ---- Batching helpers --------------------------------------------------------
test("chunk splits to the requested size", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 5), []);
  assert.throws(() => chunk([1], 0), /chunk size must be positive/);
});

test("unwrapData tolerates the common envelope shapes", () => {
  assert.deepEqual(unwrapData([1, 2]), [1, 2]);
  assert.deepEqual(unwrapData({ data: [1, 2] }), [1, 2]);
  assert.deepEqual(unwrapData({ data: { id: 1 } }), [{ id: 1 }]);
  assert.deepEqual(unwrapData({}), []);
  assert.deepEqual(unwrapData(null), []);
});

// ---- Auth --------------------------------------------------------------------
test("the API key is sent as a header, never in the URL", async () => {
  let seenHeaders;
  const impl = async (url, init) => {
    seenHeaders = init.headers;
    assert.ok(!url.includes("test-key"), "key must not appear in the URL");
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
  };
  await client(impl).get("/leagues");
  assert.equal(seenHeaders["X-Api-Key"], "test-key");
});

test("constructing without a key fails loudly", () => {
  assert.throws(
    () => new OpticOddsClient({ apiKey: "", fetchImpl: async () => {} }),
    /No OpticOdds API key/
  );
});

// ---- Retry -------------------------------------------------------------------
test("429 is retried and then succeeds", async () => {
  const impl = stubFetch([
    { status: 429, headers: { "retry-after": "0" }, body: "slow down" },
    { status: 200, body: { data: [{ id: "x" }] } },
  ]);
  const payload = await client(impl).get("/fixtures");
  assert.deepEqual(unwrapData(payload), [{ id: "x" }]);
  assert.equal(impl.calls.length, 2);
});

test("5xx is retried", async () => {
  const impl = stubFetch([
    { status: 503, body: "upstream down" },
    { status: 200, body: { data: [] } },
  ]);
  await client(impl).get("/fixtures");
  assert.equal(impl.calls.length, 2);
});

test("401 is not retried — a bad key fails the same way every time", async () => {
  const impl = stubFetch([{ status: 401, body: "unauthorized" }]);
  await assert.rejects(() => client(impl).get("/fixtures"), (err) => {
    assert.ok(err instanceof OpticOddsError);
    assert.equal(err.status, 401);
    return true;
  });
  assert.equal(impl.calls.length, 1, "must not burn rate budget retrying a 401");
});

test("retries are bounded and the final error surfaces", async () => {
  const impl = stubFetch([{ status: 500, headers: { "retry-after": "0" }, body: "boom" }]);
  await assert.rejects(
    () => client(impl, { maxRetries: 2 }).get("/fixtures"),
    /HTTP 500/
  );
  assert.equal(impl.calls.length, 3, "1 initial + 2 retries");
});

test("a non-JSON body is reported with its first bytes", async () => {
  const impl = stubFetch([{ status: 200, body: "<html>nope</html>" }]);
  await assert.rejects(() => client(impl).get("/fixtures"), /Non-JSON response/);
});

test("a network-level failure is retried", async () => {
  let n = 0;
  const impl = async () => {
    if (++n === 1) throw new Error("ECONNRESET");
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" };
  };
  await client(impl).get("/fixtures");
  assert.equal(n, 2);
});

// ---- Pagination --------------------------------------------------------------
test("total_pages drives multi-page collection", async () => {
  const impl = stubFetch([
    { status: 200, body: { data: [{ id: 1 }], total_pages: 3 } },
    { status: 200, body: { data: [{ id: 2 }], total_pages: 3 } },
    { status: 200, body: { data: [{ id: 3 }], total_pages: 3 } },
  ]);
  const rows = await client(impl).getAll("/markets");
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
  assert.ok(impl.calls[0].includes("page=1"));
  assert.ok(impl.calls[2].includes("page=3"));
});

test("an endpoint with no pagination signal is fetched once", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [{ id: 1 }, { id: 2 }] } }]);
  const rows = await client(impl).getAll("/sportsbooks");
  assert.equal(rows.length, 2);
  assert.equal(impl.calls.length, 1);
});

test("pagination is capped so a misread signal cannot loop forever", async () => {
  // Always claims more pages than it will ever deliver.
  const impl = stubFetch([{ status: 200, body: { data: [{ id: 1 }], total_pages: 9999 } }]);
  const rows = await client(impl).getAll("/markets", {}, { maxPages: 4 });
  assert.equal(rows.length, 4);
  assert.equal(impl.calls.length, 4);
});

// ---- Odds batching -----------------------------------------------------------
test("odds requests respect the 5-fixture and 5-sportsbook caps", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  // 12 fixtures x 7 books -> ceil(12/5)=3 fixture batches, ceil(7/5)=2 book
  // batches, so 6 requests.
  const fixtureIds = Array.from({ length: 12 }, (_, i) => `F${i}`);
  const sportsbooks = Array.from({ length: 7 }, (_, i) => `Book${i}`);
  await client(impl).getOddsForFixtures({ fixtureIds, sportsbooks });

  assert.equal(impl.calls.length, 6);
  for (const url of impl.calls) {
    const params = new URL(url).searchParams;
    assert.ok(params.getAll("sportsbook").length <= MAX_SPORTSBOOKS_PER_REQUEST);
    assert.ok(params.getAll("fixture_id").length <= MAX_FIXTURES_PER_REQUEST);
  }
});

test("every fixture and book combination is covered exactly once", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  const fixtureIds = ["A", "B", "C", "D", "E", "F"];
  const sportsbooks = ["X", "Y", "Z"];
  await client(impl).getOddsForFixtures({ fixtureIds, sportsbooks });

  const seen = new Set();
  for (const url of impl.calls) {
    const p = new URL(url).searchParams;
    for (const b of p.getAll("sportsbook")) {
      for (const f of p.getAll("fixture_id")) {
        const key = `${b}|${f}`;
        assert.ok(!seen.has(key), `duplicate request for ${key}`);
        seen.add(key);
      }
    }
  }
  assert.equal(seen.size, fixtureIds.length * sportsbooks.length);
});

test("one failing batch does not abort the whole pull", async () => {
  // Six books split into two batches (5 + 1); the second batch fails
  // permanently while the first succeeds.
  const sportsbooks = ["B0", "B1", "B2", "B3", "B4", "BAD"];
  let n = 0;
  const impl = async (url) => {
    if (url.includes("sportsbook=BAD")) {
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => "bad book" };
    }
    n++;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ id: n }] }),
    };
  };
  const payloads = await client(impl).getOddsForFixtures({ fixtureIds: ["A"], sportsbooks });
  // The good batch still came back; the failing one was logged and skipped
  // rather than throwing away the whole week's capture.
  assert.equal(payloads.length, 1);
  assert.deepEqual(unwrapData(payloads[0]), [{ id: 1 }]);
});

test("odds pulls report progress", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  const seen = [];
  await client(impl).getOddsForFixtures({
    fixtureIds: ["A", "B", "C", "D", "E", "F"],
    sportsbooks: ["X"],
    onProgress: (p) => seen.push(p),
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.at(-1), { done: 2, total: 2 });
});

test("an odds pull with no fixtures is a no-op, and one with no books throws", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  assert.deepEqual(await client(impl).getOddsForFixtures({ fixtureIds: [], sportsbooks: ["X"] }), []);
  assert.equal(impl.calls.length, 0);
  await assert.rejects(
    () => client(impl).getOddsForFixtures({ fixtureIds: ["A"], sportsbooks: [] }),
    /At least one sportsbook/
  );
});

test("historical odds send exactly one fixture per request", async () => {
  // Not a batching choice — /fixtures/odds/historical accepts a single
  // fixture_id, unlike /fixtures/odds which takes five. Six fixtures against
  // one book is therefore six requests, not two.
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  await client(impl).getHistoricalOdds({
    fixtureIds: ["A", "B", "C", "D", "E", "F"],
    sportsbooks: ["X"],
  });
  assert.equal(impl.calls.length, 6);
  for (const url of impl.calls) {
    assert.ok(url.includes("/fixtures/odds/historical"));
    assert.equal(new URL(url).searchParams.getAll("fixture_id").length, 1);
  }
});

test("historical odds still batch sportsbooks five at a time", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  await client(impl).getHistoricalOdds({
    fixtureIds: ["A"],
    sportsbooks: ["B0", "B1", "B2", "B3", "B4", "B5"],
  });
  assert.equal(impl.calls.length, 2); // 5 + 1
  for (const url of impl.calls) {
    assert.ok(new URL(url).searchParams.getAll("sportsbook").length <= MAX_SPORTSBOOKS_PER_REQUEST);
  }
});

test("has_more drives pagination when present", async () => {
  // The documented list envelope is { data, page, total_pages, has_more }.
  const impl = stubFetch([
    { status: 200, body: { data: [{ id: 1 }], page: 1, total_pages: 2, has_more: true } },
    { status: 200, body: { data: [{ id: 2 }], page: 2, total_pages: 2, has_more: false } },
  ]);
  const rows = await client(impl).getAll("/fixtures");
  assert.deepEqual(rows.map((r) => r.id), [1, 2]);
  assert.equal(impl.calls.length, 2);
});

// ---- Rate limiting -----------------------------------------------------------
test("the sliding window throttles once the quota is spent", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [] } }]);
  // 3 requests per 120ms: the 4th must wait for the first to age out.
  const c = client(impl, { rate: { requests: 3, perMs: 120 } });
  const started = Date.now();
  for (let i = 0; i < 4; i++) await c.get("/leagues");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100, `expected throttling, took only ${elapsed}ms`);
  assert.equal(c.requestCount, 4);
});

// ---- Deriving the league's sportsbooks ---------------------------------------
// /sportsbooks has no league filter and returns every book globally, so the
// NFL set is derived from /markets, which nests sports -> leagues -> sportsbooks.
const marketsPayload = {
  data: [
    {
      id: "player_passing_yards",
      name: "Player Passing Yards",
      sports: [
        {
          id: "football",
          name: "Football",
          leagues: [
            { id: "nfl", name: "NFL", sportsbooks: [{ id: "draftkings", name: "DraftKings" }, { id: "pinnacle", name: "Pinnacle" }] },
            { id: "ncaaf", name: "NCAAF", sportsbooks: [{ id: "college_only_book", name: "College Only" }] },
          ],
        },
      ],
    },
    {
      id: "moneyline",
      name: "Moneyline",
      sports: [
        { id: "football", name: "Football", leagues: [{ id: "nfl", name: "NFL", sportsbooks: [{ id: "moneyline_only_book", name: "Moneyline Only" }] }] },
      ],
    },
  ],
};

test("sportsbooksForLeague unions the books nested under that league", async () => {
  const impl = stubFetch([{ status: 200, body: marketsPayload }]);
  const books = await client(impl).sportsbooksForLeague({ league: "nfl" });
  const ids = books.map((b) => b.id).sort();
  // Both NFL markets contribute; the NCAAF-only book is excluded by league.
  assert.deepEqual(ids, ["draftkings", "moneyline_only_book", "pinnacle"]);
  assert.ok(!ids.includes("college_only_book"));
});

test("sportsbooksForLeague can narrow to the markets we model", async () => {
  const impl = stubFetch([{ status: 200, body: marketsPayload }]);
  const books = await client(impl).sportsbooksForLeague({
    league: "nfl",
    marketNames: ["Player Passing Yards"],
  });
  const ids = books.map((b) => b.id).sort();
  // A book that only prices moneyline is no use to a props pipeline.
  assert.deepEqual(ids, ["draftkings", "pinnacle"]);
});

test("sportsbooksForLeague matches a market by id as well as name", async () => {
  const impl = stubFetch([{ status: 200, body: marketsPayload }]);
  const books = await client(impl).sportsbooksForLeague({
    league: "nfl",
    marketNames: ["player_passing_yards"],
  });
  assert.equal(books.length, 2);
});

test("getSportsbooks sends no league filter — the endpoint has none", async () => {
  const impl = stubFetch([{ status: 200, body: { data: [], has_more: false } }]);
  await client(impl).getSportsbooks();
  const params = new URL(impl.calls[0]).searchParams;
  assert.equal(params.get("league"), null);
  assert.equal(params.get("sport"), null);
});
