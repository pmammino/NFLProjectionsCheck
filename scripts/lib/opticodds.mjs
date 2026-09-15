// HTTP client for the OpticOdds v3 API: auth, rate limiting, batching,
// pagination and retries. The only module in this project that talks to
// OpticOdds over the network; everything that interprets the *content* of a
// response lives in optic-normalize.mjs so it can be unit tested offline.
//
// ---------------------------------------------------------------------------
// API constraints this client exists to handle
// ---------------------------------------------------------------------------
//  - Auth is an `X-Api-Key` header (the API also accepts a `key` query param;
//    we use the header so the key never lands in a log line or an error
//    message containing the URL).
//  - /fixtures/odds accepts AT MOST 5 sportsbooks and AT MOST 5 fixture ids
//    per request, and sportsbooks must be sent as REPEATED query params
//    (sportsbook=A&sportsbook=B), not a comma-joined value. A full NFL week is
//    ~16 fixtures against 20+ books, so pulling a week is inherently dozens of
//    requests — hence the batching and rate limiting here rather than at the
//    call sites.
//  - Documented rate limits are per-tier, and the historical endpoints are
//    tighter than the standard ones (10 requests / 15 seconds). The limiter
//    below defaults to the tighter figure because exceeding it costs far more
//    (a 429 storm mid-capture) than running a weekly job slightly slower.
//
// ---------------------------------------------------------------------------
// CONTRACT STATUS — READ BEFORE DEBUGGING A PARSE FAILURE
// ---------------------------------------------------------------------------
// The endpoint paths, auth header, and the 5-sportsbook/5-fixture and
// 10-req/15s limits above are confirmed. The exact FIELD NAMES inside each
// response body have not been verified against a live call. Everything that
// reads a field does so through the tolerant accessors in optic-normalize.mjs,
// which try several plausible spellings and report what they could not read,
// so a schema surprise surfaces as a clear diagnostic rather than silent
// nulls. Run `node scripts/optic-discover.mjs --dump-odds` against a live key
// to print the real shapes, then tighten the accessors.

const DEFAULT_BASE_URL = "https://api.opticodds.com/api/v3";

// Hard API caps — not tuning knobs.
export const MAX_SPORTSBOOKS_PER_REQUEST = 5;
export const MAX_FIXTURES_PER_REQUEST = 5;

// Conservative default: the documented historical-endpoint limit, applied to
// everything. Override per-instance if your licence tier allows more.
const DEFAULT_RATE = { requests: 10, perMs: 15_000 };

// Split an array into chunks of at most `size`.
export function chunk(arr, size) {
  if (!(size > 0)) throw new Error(`chunk size must be positive, got ${size}`);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sliding-window rate limiter. Records the timestamp of each request and, when
// the window is full, waits until the oldest one ages out. A sliding window
// (rather than a fixed bucket) is what actually matches "N requests in any
// 15 seconds" and avoids the burst-at-the-boundary problem that gets a client
// 429'd despite respecting the average rate.
class RateLimiter {
  constructor({ requests, perMs }) {
    this.requests = requests;
    this.perMs = perMs;
    this.times = [];
  }

  async take() {
    for (;;) {
      const now = Date.now();
      this.times = this.times.filter((t) => now - t < this.perMs);
      if (this.times.length < this.requests) {
        this.times.push(now);
        return;
      }
      const waitMs = this.perMs - (now - this.times[0]) + 5; // +5ms of slack
      await sleep(waitMs);
    }
  }
}

// Build a query string, expanding array values into repeated params — which is
// what OpticOdds requires for `sportsbook` and `market`, and what
// URLSearchParams does NOT do for you if you hand it an array.
export function buildQuery(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v === undefined || v === null || v === "") continue;
        usp.append(key, String(v));
      }
    } else {
      usp.append(key, String(value));
    }
  }
  return usp.toString();
}

// Errors carry status + endpoint so a caller can distinguish "bad key" from
// "rate limited" from "this fixture has no odds" without string-matching.
export class OpticOddsError extends Error {
  constructor(message, { status, endpoint, body } = {}) {
    super(message);
    this.name = "OpticOddsError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

export class OpticOddsClient {
  constructor({
    apiKey = process.env.OPTICODDS_API_KEY,
    baseUrl = process.env.OPTICODDS_BASE_URL || DEFAULT_BASE_URL,
    rate = DEFAULT_RATE,
    maxRetries = 4,
    fetchImpl = globalThis.fetch,
    logger = console,
  } = {}) {
    if (!apiKey) {
      throw new OpticOddsError(
        "No OpticOdds API key. Set OPTICODDS_API_KEY (locally, or as a GitHub Actions secret)."
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.limiter = new RateLimiter(rate);
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.requestCount = 0;
  }

  // One GET, rate limited, with retry on 429 and 5xx.
  //
  // 4xx other than 429 is not retried: a bad key or a malformed param will
  // fail identically every time, and retrying just burns rate budget before
  // surfacing the same error.
  async get(endpoint, params = {}) {
    const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const qs = buildQuery(params);
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.take();
      this.requestCount++;

      let res;
      try {
        res = await this.fetchImpl(url, {
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        });
      } catch (err) {
        // Network-level failure (DNS, TLS, socket reset) — worth retrying.
        lastErr = new OpticOddsError(`Network error: ${err.message}`, { endpoint: path });
        if (attempt < this.maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastErr;
      }

      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new OpticOddsError(
            `Non-JSON response from ${path} (first 200 chars): ${text.slice(0, 200)}`,
            { status: res.status, endpoint: path }
          );
        }
      }

      const body = await res.text().catch(() => "");

      if (res.status === 429 || res.status >= 500) {
        lastErr = new OpticOddsError(`HTTP ${res.status} from ${path}`, {
          status: res.status,
          endpoint: path,
          body: body.slice(0, 200),
        });
        if (attempt < this.maxRetries) {
          // Honour Retry-After when the server sends one; it knows better
          // than our backoff curve does.
          const retryAfter = Number(res.headers?.get?.("retry-after"));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs(attempt);
          this.logger.warn?.(
            `  OpticOdds ${res.status} on ${path} — retrying in ${Math.round(waitMs / 1000)}s ` +
              `(attempt ${attempt + 1}/${this.maxRetries})`
          );
          await sleep(waitMs);
          continue;
        }
        throw lastErr;
      }

      // Note: the URL is deliberately NOT included here — it would carry the
      // key if this client is ever reconfigured to use the query-param form.
      throw new OpticOddsError(
        `HTTP ${res.status} from ${path}: ${body.slice(0, 200)}`,
        { status: res.status, endpoint: path, body: body.slice(0, 200) }
      );
    }
    throw lastErr;
  }

  // GET every page of a paginated endpoint, returning the concatenated rows.
  //
  // Tolerant of how the API signals "there is more": an explicit total_pages,
  // a next-page pointer, or simply a full page. Capped so a pagination
  // misunderstanding can't become an infinite loop against a rate-limited API.
  async getAll(endpoint, params = {}, { maxPages = 50 } = {}) {
    const rows = [];
    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.get(endpoint, { ...params, page });
      const batch = unwrapData(payload);
      rows.push(...batch);

      const totalPages = Number(payload?.total_pages ?? payload?.totalPages);
      if (Number.isFinite(totalPages)) {
        if (page >= totalPages) return rows;
        continue;
      }
      // No page count advertised: stop on the first empty or short page.
      if (batch.length === 0) return rows;
      const pageSize = Number(payload?.per_page ?? payload?.limit);
      if (Number.isFinite(pageSize) && batch.length < pageSize) return rows;
      if (!Number.isFinite(pageSize)) return rows; // single-shot endpoint
    }
    this.logger.warn?.(`  ${endpoint}: hit the ${maxPages}-page cap — results may be truncated.`);
    return rows;
  }

  // ---- Discovery ----------------------------------------------------------
  // These drive the market/sportsbook mapping instead of hardcoding names that
  // would silently rot when OpticOdds renames something.

  async getSportsbooks(params = {}) {
    return this.getAll("/sportsbooks", params);
  }

  async getMarkets({ sport = "football", league = "nfl" } = {}) {
    return this.getAll("/markets", { sport, league });
  }

  async getLeagues({ sport = "football" } = {}) {
    return this.getAll("/leagues", { sport });
  }

  // ---- Fixtures -----------------------------------------------------------

  // Fixtures for a league, optionally narrowed to a season year/week. The
  // season_week filter is what makes a clean per-week pull possible.
  async getFixtures({ league = "nfl", sport = "football", seasonYear, seasonWeek, seasonType, startDate, endDate, status } = {}) {
    return this.getAll("/fixtures", {
      sport,
      league,
      season_year: seasonYear,
      season_week: seasonWeek,
      season_type: seasonType,
      start_date: startDate,
      end_date: endDate,
      status,
    });
  }

  // ---- Odds ---------------------------------------------------------------

  // Current odds for a set of fixtures across a set of sportsbooks.
  //
  // Handles the API's 5-and-5 caps by fanning out over the cartesian product
  // of fixture batches and sportsbook batches. Returns the raw per-request
  // payloads; interpreting them is optic-normalize.mjs's job.
  //
  // `onProgress({ done, total })` is called after each request so a long
  // weekly pull can report progress instead of looking hung.
  async getOddsForFixtures({ fixtureIds, sportsbooks, markets, oddsFormat = "AMERICAN", onProgress } = {}) {
    if (!fixtureIds?.length) return [];
    if (!sportsbooks?.length) throw new OpticOddsError("At least one sportsbook is required.");

    const fixtureBatches = chunk(fixtureIds, MAX_FIXTURES_PER_REQUEST);
    const bookBatches = chunk(sportsbooks, MAX_SPORTSBOOKS_PER_REQUEST);
    const total = fixtureBatches.length * bookBatches.length;

    const payloads = [];
    let done = 0;
    for (const books of bookBatches) {
      for (const fixtures of fixtureBatches) {
        try {
          const payload = await this.get("/fixtures/odds", {
            sportsbook: books,
            fixture_id: fixtures,
            market: markets,
            odds_format: oddsFormat,
          });
          payloads.push(payload);
        } catch (err) {
          // One book/fixture combination failing (a book that doesn't price
          // this game, say) must not abort the whole week's capture.
          this.logger.warn?.(
            `  odds fetch failed for books=[${books.join(",")}] ` +
              `fixtures=[${fixtures.length}]: ${err.message}`
          );
        }
        onProgress?.({ done: ++done, total });
      }
    }
    return payloads;
  }

  // Historical odds for a set of fixtures — the path to backfilling a week
  // that has already been played.
  //
  // OpticOdds exposes history two ways and they answer different questions:
  //   /fixtures/odds/historical  — the full price history of an odd (every
  //       change, lock, unlock and settlement, with timestamps). Use this to
  //       reconstruct a CLOSING line, which is the honest price to grade a
  //       backfilled bet against.
  //   /fixtures/odds  with a timestamp — the snapshot as of a moment.
  // We take the historical series and let the caller pick the moment, because
  // "the last price before kickoff" cannot be recovered from a snapshot taken
  // at the wrong time.
  async getHistoricalOdds({ fixtureIds, sportsbooks, markets, oddsFormat = "AMERICAN", onProgress } = {}) {
    if (!fixtureIds?.length) return [];
    if (!sportsbooks?.length) throw new OpticOddsError("At least one sportsbook is required.");

    const fixtureBatches = chunk(fixtureIds, MAX_FIXTURES_PER_REQUEST);
    const bookBatches = chunk(sportsbooks, MAX_SPORTSBOOKS_PER_REQUEST);
    const total = fixtureBatches.length * bookBatches.length;

    const payloads = [];
    let done = 0;
    for (const books of bookBatches) {
      for (const fixtures of fixtureBatches) {
        try {
          const payload = await this.get("/fixtures/odds/historical", {
            sportsbook: books,
            fixture_id: fixtures,
            market: markets,
            odds_format: oddsFormat,
          });
          payloads.push(payload);
        } catch (err) {
          this.logger.warn?.(
            `  historical odds fetch failed for books=[${books.join(",")}]: ${err.message}`
          );
        }
        onProgress?.({ done: ++done, total });
      }
    }
    return payloads;
  }
}

// Exponential backoff with full jitter: 1s, 2s, 4s, 8s (randomized). Jitter
// matters because every retry in a batched pull would otherwise re-collide at
// exactly the same moment.
function backoffMs(attempt) {
  const base = 1000 * 2 ** attempt;
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

// Pull the row array out of a response, tolerating the common envelope shapes.
export function unwrapData(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.data && typeof payload.data === "object") return [payload.data];
  return [];
}
