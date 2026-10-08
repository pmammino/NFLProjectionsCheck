"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Explainer from "./Explainer";
import {
  bestEdge,
  edgeAt,
  fairOver,
  formatOdds,
  inPlay,
  lineView,
  mainLineIndex,
  resultOf,
  searchPlayers,
} from "@/scripts/lib/lines-view.mjs";
import {
  LINES_SCHEMA,
  MARKET_SOURCES,
  STAT_LABELS,
  SLOT_INFO,
  slotLabel,
  type CorrectionInfo,
  type LineEntry,
  type LineTarget,
  type LinesIndex,
  type PlayerEntry,
  type SlotFile,
  type StatEntry,
} from "@/lib/lines";

// The Line Pricer tab reads public/data/lines/ (built by
// scripts/build-lines-data.mjs). Where the Paper Trading tab shows the bets a
// persona TOOK, this shows any line that was quoted: what our projection says
// about it, what the books say, and who is offering what.
//
// The presentational rules this component exists to enforce:
//
//  - A capture is an instrument. The same line is priced differently on the
//    Tuesday drop, the opening board and the closing board, so the capture on
//    screen is always named and never merged with another.
//  - The market price says whether it was MEASURED or INFERRED. A price built
//    from one-sided quotes has an assumed margin stripped from it, and should
//    not read like a number a book implied.
//  - Best price means best BETTABLE price. A reference book (Pinnacle) is shown
//    in the per-book table, flagged, and never offered as the price to take.

const pct = (n: number | null | undefined, d = 1) =>
  n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`;
const signedPct = (n: number | null | undefined, d = 1) =>
  n === null || n === undefined ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`;
const num = (n: number | null | undefined, d = 1) =>
  n === null || n === undefined ? "—" : n.toFixed(d);

// An edge at or above this is worth a look. It is the bar the ledgers use.
const EDGE_BAR = 0.03;

export default function LinePricerView({
  target,
  onConsumed,
}: {
  target: LineTarget | null;
  // Called once the handed-over bet has been taken in. The Dashboard unmounts
  // this tab whenever you leave it, so without this a stale target would be
  // re-applied on every return and override what you had since selected.
  onConsumed?: () => void;
}) {
  const [index, setIndex] = useState<LinesIndex | null>(null);
  const [indexErr, setIndexErr] = useState<string | null>(null);
  const [week, setWeek] = useState<number | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  // Whether the person has picked a capture themselves. Until they have, changing
  // the week follows that week's FULLEST board; after, it stays on the kind of
  // capture they chose. Without this, moving from the latest week (often just a
  // thin Tuesday board) to an older one would keep the thin board and hide most
  // players.
  const [slotChosen, setSlotChosen] = useState(false);

  const [file, setFile] = useState<SlotFile | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map<string, SlotFile>());

  const [query, setQuery] = useState("");
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [stat, setStat] = useState<string | null>(null);
  const [useCorrected, setUseCorrected] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  // Far-from-even lines are hidden by default (they are most of a ladder and
  // none of the decisions); this shows them. See inPlay in lines-view.mjs.
  const [showAll, setShowAll] = useState(false);
  const [pending, setPending] = useState<LineTarget | null>(null);

  // 1. the index
  useEffect(() => {
    fetch("/data/lines/index.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((ix: LinesIndex) => {
        if (ix.schema !== LINES_SCHEMA) {
          throw new Error(
            `the line index is schema ${ix.schema ?? "unknown"} but this page reads schema ${LINES_SCHEMA}`
          );
        }
        setIndex(ix);
        const w = ix.weeks.find((x) => x.week === ix.defaultWeek) ?? ix.weeks[ix.weeks.length - 1];
        if (w) {
          setWeek(w.week);
          setSlot(w.defaultSlot);
        }
      })
      .catch((e) => setIndexErr(String(e)));
  }, []);

  // 2. a bet handed over from the Paper Trading tab. Resolved against what was
  //    actually built: if that capture is no longer in the window, fall back to
  //    the week's fullest board rather than showing nothing.
  useEffect(() => {
    if (!target || !index) return;
    const w = index.weeks.find((x) => x.week === target.week);
    if (!w) return;
    setWeek(w.week);
    setSlot(w.slots.some((s) => s.slot === target.slot) ? target.slot : w.defaultSlot);
    setPending(target);
    onConsumed?.();
  }, [target, index, onConsumed]);

  // 3. the capture's file
  const currentSlot = useMemo(
    () => index?.weeks.find((w) => w.week === week)?.slots.find((s) => s.slot === slot) ?? null,
    [index, week, slot]
  );
  useEffect(() => {
    if (!currentSlot) return;
    const hit = cache.current.get(currentSlot.file);
    if (hit) {
      setFile(hit);
      setFileErr(null);
      return;
    }
    let live = true;
    setLoading(true);
    setFileErr(null);
    fetch(`/data/lines/${currentSlot.file}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((f: SlotFile) => {
        if (f.schema !== LINES_SCHEMA) {
          throw new Error(`${currentSlot.file} is schema ${f.schema ?? "unknown"}, expected ${LINES_SCHEMA}`);
        }
        cache.current.set(currentSlot.file, f);
        if (live) setFile(f);
      })
      .catch((e) => live && setFileErr(String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [currentSlot]);

  const player: PlayerEntry | null = useMemo(
    () => file?.players.find((p) => p.id === playerId) ?? null,
    [file, playerId]
  );

  // 4. once the right file is loaded, open the handed-over bet. Guarded on the
  //    capture actually selected, not just the week: while the new file is in
  //    flight `file` is still the previous capture, and selecting from that
  //    would open the line on the wrong board.
  useEffect(() => {
    if (!pending || !file || file.week !== week || file.slot !== slot) return;
    const p = file.players.find((x) => x.id === pending.playerId);
    if (p && p.stats[pending.stat]) {
      setPlayerId(p.id);
      setQuery(p.name);
      setStat(pending.stat);
      setExpanded(pending.line);
    }
    setPending(null);
  }, [pending, file, week, slot]);

  // Keep the selection coherent as the capture changes underneath it: the same
  // player in another capture stays selected, and a stat that capture lacks
  // falls back to one it has.
  useEffect(() => {
    if (!file || pending) return;
    if (playerId && !file.players.some((p) => p.id === playerId)) {
      setPlayerId(null);
      setStat(null);
      setExpanded(null);
    }
  }, [file, playerId, pending]);
  const statKeys = useMemo(() => (player ? Object.keys(player.stats) : []), [player]);
  const activeStat: string | null = useMemo(() => {
    if (!player) return null;
    if (stat && player.stats[stat]) return stat;
    // Most-quoted first: that is the stat with a ladder worth reading.
    return [...statKeys].sort((a, b) => player.stats[b].lines.length - player.stats[a].lines.length)[0] ?? null;
  }, [player, stat, statKeys]);
  const statEntry: StatEntry | null = player && activeStat ? player.stats[activeStat] : null;

  const matches = useMemo(
    () => (file && query && !(player && query === player.name) ? searchPlayers(file.players, query, 12) : []),
    [file, query, player]
  );
  const popular = useMemo(
    () =>
      file
        ? [...file.players]
            .map((p) => ({ p, n: Object.values(p.stats).reduce((s, st) => s + st.lines.length, 0) }))
            .sort((a, b) => b.n - a.n)
            .slice(0, 14)
            .map((x) => x.p)
        : [],
    [file]
  );

  // The ladder of lines, with each one's numbers worked out once.
  const rows = useMemo(() => {
    if (!file || !statEntry) return [];
    return statEntry.lines.map((l) => ({ entry: l, view: lineView(l, file.books, { useCorrected }) }));
  }, [file, statEntry, useCorrected]);
  const mainIdx = useMemo(() => mainLineIndex(statEntry?.lines ?? []), [statEntry]);
  const anyCorrected = rows.some((r) => r.entry.a !== null);
  const anySharp = rows.some((r) => r.entry.s !== null);

  // Scroll a handed-over line into view once it is on screen.
  useEffect(() => {
    if (expanded === null) return;
    const el = document.getElementById(`line-${expanded}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [expanded, activeStat, playerId]);

  if (indexErr)
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-red-400">
        Could not load the line index: {indexErr}. Run <code className="text-slate-300">npm run build:lines</code> to
        regenerate it.
      </div>
    );
  if (!index) return <div className="p-4 text-slate-400">Loading the line board…</div>;
  if (index.weeks.length === 0)
    return (
      <div className="space-y-6">
        <PricerExplainer />
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-center text-sm text-slate-400">
          No prop captures yet. Run <code className="text-slate-300">npm run capture-props</code>, then{" "}
          <code className="text-slate-300">npm run build:lines</code>.
        </div>
      </div>
    );

  const weekEntry = index.weeks.find((w) => w.week === week);

  return (
    <div className="space-y-5">
      <PricerExplainer />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <label className="space-y-1 text-xs text-slate-400">
          <span className="block font-medium">Week</span>
          <select
            aria-label="Line pricer week"
            value={week ?? ""}
            onChange={(e) => {
              const w = index.weeks.find((x) => x.week === Number(e.target.value));
              if (!w) return;
              setWeek(w.week);
              setSlot(slotChosen && w.slots.some((s) => s.slot === slot) ? slot : w.defaultSlot);
            }}
            className="block rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200"
          >
            {index.weeks.map((w) => (
              <option key={w.week} value={w.week}>
                Week {w.week}
                {w.hasActuals ? "" : " (not played)"}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs text-slate-400">
          <span className="block font-medium">Capture</span>
          <select
            aria-label="Line pricer capture"
            value={slot ?? ""}
            onChange={(e) => {
              setSlot(e.target.value);
              setSlotChosen(true);
            }}
            className="block rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-200"
          >
            {weekEntry?.slots.map((s) => (
              <option key={s.slot} value={s.slot}>
                {slotLabel(s.slot)} — {s.markets.toLocaleString()} lines
              </option>
            ))}
          </select>
        </label>

        <div className="relative min-w-[16rem] flex-1 space-y-1 text-xs text-slate-400">
          <label htmlFor="pricer-player" className="block font-medium">
            Player
          </label>
          <input
            id="pricer-player"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (playerId) {
                setPlayerId(null);
                setStat(null);
                setExpanded(null);
              }
            }}
            placeholder="Search a player or team — e.g. “st brown” or “KC”"
            autoComplete="off"
            className="block w-full rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500"
          />
          {matches.length > 0 && (
            <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded border border-slate-700 bg-slate-900 shadow-lg">
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    onClick={() => {
                      setPlayerId(p.id);
                      setQuery(p.name);
                      setStat(null);
                      setExpanded(null);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-slate-200 hover:bg-slate-800"
                  >
                    <span>{p.name}</span>
                    <span className="text-xs text-slate-500">
                      {p.pos} · {p.team}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {currentSlot && (
        <p className="-mt-2 text-[11px] leading-relaxed text-slate-500">
          <span className="font-medium text-slate-400">{slotLabel(currentSlot.slot)}.</span>{" "}
          {SLOT_INFO[currentSlot.slot]?.blurb ?? "A capture of this week's board."}{" "}
          {currentSlot.markets.toLocaleString()} lines across {currentSlot.players} players.
        </p>
      )}

      {fileErr && (
        <p className="text-sm text-red-400">
          Could not load this capture: {fileErr}. Run <code className="text-slate-300">npm run build:lines</code> to
          regenerate it.
        </p>
      )}
      {loading && !file && <p className="text-sm text-slate-400">Loading this capture…</p>}

      {file && !player && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <p className="mb-2 text-xs font-medium text-slate-400">Most-quoted players this week</p>
          <div className="flex flex-wrap gap-1.5">
            {popular.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setPlayerId(p.id);
                  setQuery(p.name);
                  setStat(null);
                  setExpanded(null);
                }}
                className="rounded bg-slate-800 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-slate-700"
              >
                {p.name} <span className="text-slate-500">{p.team}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {file && player && statEntry && activeStat && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-100">{player.name}</span>
            <span className="text-xs text-slate-500">
              {player.pos} · {player.team}
              {player.opp ? ` ${player.opp}` : ""} · Week {file.week}
            </span>
            <div className="ml-auto flex flex-wrap gap-1">
              {statKeys.map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    setStat(k);
                    setExpanded(null);
                  }}
                  className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                    activeStat === k
                      ? "bg-brand-red text-white"
                      : "bg-slate-800 text-slate-400 hover:bg-slate-700"
                  }`}
                >
                  {STAT_LABELS[k] ?? k}
                </button>
              ))}
            </div>
          </div>

          <ProjectionCard
            stat={activeStat}
            entry={statEntry}
            correction={file.correction?.[activeStat] ?? null}
            useCorrected={useCorrected}
            setUseCorrected={setUseCorrected}
            canCorrect={anyCorrected}
          />

          <LinesTable
            file={file}
            stat={activeStat}
            entry={statEntry}
            rows={rows}
            mainIdx={mainIdx}
            anySharp={anySharp}
            expanded={expanded}
            setExpanded={setExpanded}
            useCorrected={useCorrected}
            showAll={showAll}
            setShowAll={setShowAll}
          />
        </>
      )}
    </div>
  );
}

// --- projection ----------------------------------------------------------------

function ProjectionCard({
  stat,
  entry,
  correction,
  useCorrected,
  setUseCorrected,
  canCorrect,
}: {
  stat: string;
  entry: StatEntry;
  correction: CorrectionInfo | null;
  useCorrected: boolean;
  setUseCorrected: (v: boolean) => void;
  canCorrect: boolean;
}) {
  const poisson = entry.kind === "poisson";
  const p = entry.proj;
  return (
    <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-4 sm:grid-cols-[auto_1fr]">
      <div className="space-y-2">
        <p className="text-xs font-medium text-slate-400">
          Projection{poisson ? " (expected count)" : " — Floor / Median / Ceiling"}
        </p>
        {p ? (
          poisson ? (
            <p className="text-lg font-semibold tabular-nums text-median">{num(p.M, 2)}</p>
          ) : (
            <div className="flex items-baseline gap-4 tabular-nums">
              <span className="text-floor">{num(p.F)}</span>
              <span className="text-lg font-semibold text-median">{num(p.M)}</span>
              <span className="text-ceiling">{num(p.C)}</span>
            </div>
          )
        ) : (
          <p className="text-sm text-slate-500">No projection snapshot for this week.</p>
        )}
        {entry.adj && (
          <p className="text-xs text-slate-400">
            Re-centred:{" "}
            <span className="tabular-nums text-slate-200">
              {num(entry.adj.F)} / {num(entry.adj.M)} / {num(entry.adj.C)}
            </span>
          </p>
        )}
      </div>

      <div className="space-y-1.5 text-xs leading-relaxed text-slate-400">
        {entry.actual !== null ? (
          <p>
            Result: <span className="font-semibold tabular-nums text-slate-100">{entry.actual}</span>{" "}
            {STAT_LABELS[stat]?.toLowerCase() ?? stat}
            {p && !poisson ? (
              <span className="text-slate-500">
                {" "}
                ({entry.actual > p.M ? "above" : entry.actual < p.M ? "below" : "at"} the projected median)
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-slate-500">No result recorded — not played yet, or no stat line in the feed.</p>
        )}

        {entry.stale && entry.priced !== null && p && (
          <p className="rounded border border-amber-700/40 bg-amber-950/30 px-2 py-1 text-amber-300/90">
            Priced from an earlier projection: the median was {num(entry.priced, 2)} when this capture was taken and
            is {num(p.M, 2)} now. “Ours” below is the earlier price, and a re-centred price is not offered, because
            comparing the two projections would not be like for like.
          </p>
        )}

        {correction && (
          <p>
            Median correction as of this week:{" "}
            {correction.applied ? (
              <span className="text-slate-300">
                applied — the median is scaled by {correction.kM.toFixed(2)} (fitted on {correction.n} player-weeks,
                z = {correction.z.toFixed(1)})
              </span>
            ) : (
              <span className="text-slate-500">not applied ({correction.reason.replace(/-/g, " ")})</span>
            )}
            .
          </p>
        )}

        {canCorrect && (
          <label className="flex cursor-pointer items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={useCorrected}
              onChange={(e) => setUseCorrected(e.target.checked)}
              className="accent-brand-red"
            />
            Price off the median-corrected projection
            <span className="text-slate-500">(off in the live ledger)</span>
          </label>
        )}
      </div>
    </div>
  );
}

// --- the ladder of lines ---------------------------------------------------------

type Row = { entry: LineEntry; view: ReturnType<typeof lineView> };

function LinesTable({
  file,
  stat,
  entry,
  rows,
  mainIdx,
  anySharp,
  expanded,
  setExpanded,
  useCorrected,
  showAll,
  setShowAll,
}: {
  file: SlotFile;
  stat: string;
  entry: StatEntry;
  rows: Row[];
  mainIdx: number;
  anySharp: boolean;
  expanded: number | null;
  setExpanded: (l: number | null) => void;
  useCorrected: boolean;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
}) {
  // The line that is open is always shown, however far from even: a bet handed
  // over from the ledger must not vanish behind the filter that hides its row.
  const mainEntry = rows[mainIdx]?.entry;
  const shown = rows.filter((r) => showAll || inPlay(r.entry) || r.entry.l === expanded || r.entry === mainEntry);
  const hidden = rows.length - shown.length;
  const cols = 10 + (anySharp ? 1 : 0);
  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2">
        <span className="text-xs font-medium text-slate-300">{STAT_LABELS[stat] ?? stat} lines</span>
        <span className="text-[11px] text-slate-500">
          {shown.length} of {rows.length} quoted · click a line for every book’s price
        </span>
        {(hidden > 0 || showAll) && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 transition hover:bg-slate-700"
          >
            {showAll ? "Hide far-from-even lines" : `Show ${hidden} far-from-even`}
          </button>
        )}
        <span className="ml-auto text-[11px] text-slate-500">
          {useCorrected ? "ours = median-corrected where available" : "ours = as priced at this capture"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-left text-slate-400">
            <tr>
              <th className="px-3 py-2 text-right">Line</th>
              <th className="px-3 py-2 text-right">Ours</th>
              <th className="px-3 py-2 text-right" title="Median no-vig price across the retail books">
                Market
              </th>
              {anySharp && (
                <th className="px-3 py-2 text-right" title="Median no-vig price across the sharp books (Circa, Pinnacle)">
                  Sharp
                </th>
              )}
              <th className="px-3 py-2 text-right" title="Our P(over) minus the market's. Positive = we are higher on the over.">
                Ours − mkt
              </th>
              <th className="px-3 py-2 text-right">Best over</th>
              <th className="px-3 py-2 text-right" title="Our P(over) minus the break-even probability at that price">
                Edge
              </th>
              <th className="px-3 py-2 text-right">Best under</th>
              <th className="px-3 py-2 text-right">Edge</th>
              <th className="px-3 py-2 text-right">Books</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ entry: l, view: v }) => {
              const open = expanded === l.l;
              const be = bestEdge(v);
              const res = resultOf(entry.actual, l.l);
              return (
                <RowGroup key={l.l}>
                  <tr
                    id={`line-${l.l}`}
                    onClick={() => setExpanded(open ? null : l.l)}
                    className={`cursor-pointer border-b border-slate-800/40 hover:bg-slate-800/40 ${
                      open ? "bg-slate-800/50" : ""
                    } ${l === mainEntry ? "border-l-2 border-l-brand-red" : ""}`}
                  >
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-slate-200">
                      {l.l}
                      {l === mainEntry ? (
                        <span className="ml-1.5 rounded bg-brand-red/20 px-1 text-[10px] font-semibold text-brand-red">
                          main
                        </span>
                      ) : null}
                    </td>
                    <td
                      className="px-3 py-2 text-right tabular-nums text-blue-300"
                      title={v.corrected ? "median-corrected" : "as priced at this capture"}
                    >
                      {pct(v.p)}
                      {v.corrected ? <span className="ml-0.5 text-[10px] text-sky-400">c</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                      {pct(v.market)}
                      {typeof l.q === "number" && l.q !== 0 ? (
                        <span
                          className="ml-0.5 text-amber-500/80"
                          title={
                            MARKET_SOURCES[l.q] === "assumed-hold"
                              ? "inferred: every book quoted one side only, so an assumed margin was stripped"
                              : "partly inferred: some books quoted one side only"
                          }
                        >
                          †
                        </span>
                      ) : null}
                    </td>
                    {anySharp && <td className="px-3 py-2 text-right tabular-nums text-slate-400">{pct(v.sharp)}</td>}
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        v.gap === null ? "text-slate-500" : v.gap > 0 ? "text-emerald-300/80" : "text-rose-300/80"
                      }`}
                    >
                      {signedPct(v.gap)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                      <Price best={v.bestOver} books={file.books} />
                    </td>
                    <EdgeCell value={v.edgeOver} />
                    <td className="px-3 py-2 text-right tabular-nums text-slate-300">
                      <Price best={v.bestUnder} books={file.books} />
                    </td>
                    <EdgeCell value={v.edgeUnder} />
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">{v.nBooks}</td>
                    <td className="px-3 py-2">
                      <ResultBadge result={res} />
                      {be && be.edge >= EDGE_BAR && res === null ? (
                        <span className="ml-1 text-[10px] text-emerald-400/80">{be.side}</span>
                      ) : null}
                    </td>
                  </tr>
                  {open && (
                    <tr className="border-b border-slate-800/60 bg-slate-950/60">
                      <td colSpan={cols} className="px-4 py-3">
                        <BookTable line={l} view={v} file={file} />
                      </td>
                    </tr>
                  )}
                </RowGroup>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        <span className="text-amber-500/80">†</span> the market price is inferred from one-sided quotes (an assumed
        margin is stripped), not measured. <span className="text-sky-400">c</span> = median-corrected. A quoted price at a
        reference book is shown when you open a line but is never offered as the price to take.
      </p>
    </div>
  );
}

// A fragment that can carry a key without adding a DOM node.
function RowGroup({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function Price({ best, books }: { best: { odds: number; book: number } | null; books: SlotFile["books"] }) {
  if (!best) return <span className="text-slate-600">—</span>;
  return (
    <>
      <span className="font-medium">{formatOdds(best.odds)}</span>{" "}
      <span className="text-slate-500">{books[best.book]?.label}</span>
    </>
  );
}

function EdgeCell({ value }: { value: number | null }) {
  const good = value !== null && value >= EDGE_BAR;
  return (
    <td
      className={`px-3 py-2 text-right tabular-nums ${
        value === null ? "text-slate-600" : good ? "font-semibold text-emerald-300" : value < 0 ? "text-slate-500" : "text-slate-400"
      }`}
    >
      {signedPct(value)}
    </td>
  );
}

function ResultBadge({ result }: { result: "over" | "under" | "push" | null }) {
  if (!result) return <span className="text-slate-600">—</span>;
  const cls =
    result === "over"
      ? "bg-emerald-900/40 text-emerald-300"
      : result === "under"
        ? "bg-sky-900/40 text-sky-300"
        : "bg-slate-800 text-slate-400";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>{result}</span>;
}

// --- per-book detail ------------------------------------------------------------

function BookTable({ line, view, file }: { line: LineEntry; view: ReturnType<typeof lineView>; file: SlotFile }) {
  const ordered = [...line.b].sort((a, b) => a[0] - b[0]);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">
        Line {line.l} — every book that quoted it. No-vig is each book’s own price with its margin removed; it exists
        only where a book quoted both sides.
      </p>
      <table className="w-full max-w-3xl text-xs">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="py-1 pr-3">Book</th>
            <th className="py-1 pr-3 text-right">Over</th>
            <th className="py-1 pr-3 text-right">Under</th>
            <th className="py-1 pr-3 text-right">No-vig over</th>
            <th className="py-1 pr-3 text-right">Edge over</th>
            <th className="py-1 text-right">Edge under</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map(([bi, over, under]) => {
            const book = file.books[bi];
            const fair = fairOver(over, under);
            const isBestO = view.bestOver?.book === bi;
            const isBestU = view.bestUnder?.book === bi;
            return (
              <tr key={bi} className="border-t border-slate-800/50">
                <td className="py-1 pr-3 text-slate-300">
                  {book?.label ?? "?"}
                  {book && !book.t ? (
                    <span className="ml-1.5 rounded bg-slate-800 px-1 text-[10px] text-slate-400">reference</span>
                  ) : null}
                </td>
                <td className={`py-1 pr-3 text-right tabular-nums ${isBestO ? "font-semibold text-emerald-300" : "text-slate-300"}`}>
                  {formatOdds(over)}
                  {isBestO ? " ★" : ""}
                </td>
                <td className={`py-1 pr-3 text-right tabular-nums ${isBestU ? "font-semibold text-emerald-300" : "text-slate-300"}`}>
                  {formatOdds(under)}
                  {isBestU ? " ★" : ""}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-slate-400">
                  {fair === null ? <span className="text-slate-600">one-sided</span> : pct(fair)}
                </td>
                <td className="py-1 pr-3 text-right tabular-nums text-slate-400">
                  {over !== null && view.p !== null ? signedPct(edgeAt(view.p, over, "over")) : "—"}
                </td>
                <td className="py-1 text-right tabular-nums text-slate-400">
                  {under !== null && view.p !== null ? signedPct(edgeAt(view.p, under, "under")) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-slate-600">★ best price at a book a bet can be placed at.</p>
    </div>
  );
}

// --- explainer ---------------------------------------------------------------------

function PricerExplainer() {
  return (
    <Explainer title="What this shows & how to read it" defaultOpen={false}>
      <p>
        The Paper Trading tab shows the bets a simulated bettor <b>took</b>. This shows <b>any line that was quoted</b>:
        pick a player and a stat and see the whole ladder, with what our projection says about each line, what the books
        say, and who is offering what.
      </p>
      <ul className="list-disc pl-5">
        <li>
          <b>Ours</b> — our P(over): the projected Floor/Median/Ceiling treated as the 25th/50th/75th percentiles, joined
          into one distribution, read off at the line. For counts (TDs) it is a Poisson on the projected number.
        </li>
        <li>
          <b>Market</b> — the median no-vig P(over) across the retail books. A <b>†</b> means it was inferred from
          one-sided quotes rather than measured.
        </li>
        <li>
          <b>Edge</b> — our probability of winning that side minus the break-even probability at the best price a book
          you can actually bet at is offering. At −110 you need 52.4%, not 50%, because the margin is a cost really paid.
        </li>
        <li>
          <b>Capture</b> — the same line is priced differently on the Tuesday drop, the opening board and the closing
          board. They are different instruments and are never merged.
        </li>
      </ul>
      <p>
        Read the gap, not just the edge. Near 50/50 the books have beaten our projection on the 2026 data, so a large
        “ours − market” is more often our error than their mistake. This is paper-trading data, not betting advice.
      </p>
    </Explainer>
  );
}
