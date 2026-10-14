"use client";

import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LineTarget } from "@/lib/lines";
import {
  PRESETS,
  presetFilters,
  applyFilters,
  summarize,
  groupSummaries,
  betsToResolve,
  verdict,
  oddsBucket,
  edgeBucket,
  isAmerican,
  unpack,
  DEFAULT_ODDS_MIN,
  DEFAULT_ODDS_MAX,
  LIVE_SLOTS,
  SLOT_ORDER,
  MIN_BETS_FOR_A_VERDICT,
  type Filters,
  type Row,
  type Bet,
  type Summary,
  type Group,
  type Packed,
  type PlayerInfo,
  type Preset,
} from "@/scripts/lib/paper-filter.mjs";

// The Filtered Paper Trading tab. It reads public/data/paper.json (every
// candidate bet on the live captures, built by scripts/build-paper-data.mjs) and
// does the choosing here, in the browser, with the same engine the tests run
// (scripts/lib/paper-filter.mjs). Nothing on this tab is a persona: a persona is a
// fixed strategy, and the point of this tab is to change the strategy and watch
// what happens.

// ---- Shapes ------------------------------------------------------------------

// What build-paper-data.mjs writes: the packed rows plus what the tab needs around them.
interface Dataset extends Packed {
  meta: { generatedAt: string; season: number | null; weeks: number[]; completeWeeks: number[]; candidates: number; empty?: boolean; sharpBooks: string[] };
  players: PlayerInfo[];
}

// ---- Labels and formatting ------------------------------------------------------

const STAT_LABELS: Record<string, string> = {
  passYds: "Pass Yards",
  passAtt: "Pass Attempts",
  completions: "Completions",
  passTD: "Pass TD",
  int: "Interceptions",
  rushYds: "Rush Yards",
  rushAtt: "Rush Attempts",
  receptions: "Receptions",
  recYds: "Rec Yards",
  anytimeTD: "Anytime TD",
};
const SLOT_LABELS: Record<string, string> = {
  opening: "Opening (reconstructed)",
  main: "Tuesday",
  thursday: "Thursday",
  saturday: "Saturday",
  closing: "Closing (reconstructed)",
};
const statLabel = (s: string) => STAT_LABELS[s] ?? s;

const pct = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(d)}%`);
const spct = (n: number | null | undefined, d = 1) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(d)}%`);
const units = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}u`;
const american = (o: number) => (o > 0 ? `+${o}` : `${o}`);
const decToAmerican = (d: number | null) => (d === null ? "—" : d >= 2 ? `+${Math.round((d - 1) * 100)}` : `${Math.round(-100 / (d - 1))}`);
// A ladder can run fifty rungs either side of the main line; the table groups them.
const RUNG_BUCKETS: [string, (d: number) => boolean][] = [
  ["Main line", (d) => d === 0],
  ["1 rung away", (d) => d === 1],
  ["2–3 rungs away", (d) => d <= 3],
  ["4–10 rungs away", (d) => d <= 10],
  ["11+ rungs away (far tails)", () => true],
];
const rungBucket = (r: number) => RUNG_BUCKETS.find(([, test]) => test(Math.abs(r)))![0];
const rungLabel = (r: number) => (r === 0 ? "Main line" : `${r > 0 ? "+" : ""}${r} rung${Math.abs(r) === 1 ? "" : "s"}`);

// Clicking a row in a breakdown narrows the filters to it: the drill-down.
type Drill = Partial<Filters>;

// ---- The component --------------------------------------------------------------

export default function FilteredPaperView({ onOpenLine }: { onOpenLine?: (t: LineTarget) => void }) {
  const [live, setLive] = useState<Dataset | null>(null);
  const [recon, setRecon] = useState<Dataset | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [includeRecon, setIncludeRecon] = useState(false);
  const [reconLoading, setReconLoading] = useState(false);
  const [presetId, setPresetId] = useState("realistic");
  const [filters, setFilters] = useState<Filters>(() => presetFilters("realistic"));

  useEffect(() => {
    fetch("/data/paper.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: Dataset) => setLive(d))
      .catch((e) => setErr(String(e)));
  }, []);

  // The reconstructed boards are the bigger file and the flattering one, so they
  // are fetched only when asked for.
  useEffect(() => {
    if (!includeRecon || recon || reconLoading) return;
    setReconLoading(true);
    fetch("/data/paper-recon.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: Dataset) => setRecon(d))
      .catch((e) => setErr(String(e)))
      .finally(() => setReconLoading(false));
  }, [includeRecon, recon, reconLoading]);

  const liveRows = useMemo(() => (live && !live.meta.empty ? unpack(live, live.players) : []), [live]);
  const reconRows = useMemo(() => (recon && !recon.meta.empty ? unpack(recon, recon.players) : []), [recon]);
  const rows = useMemo(() => (includeRecon ? [...liveRows, ...reconRows] : liveRows), [includeRecon, liveRows, reconRows]);

  const completeWeeks = live?.meta.completeWeeks ?? [];
  const bets = useMemo(() => applyFilters(rows, filters), [rows, filters]);
  const total = useMemo(() => summarize(bets, { completeWeeks }), [bets, completeWeeks]);

  const allStats = useMemo(() => [...new Set(rows.map((r) => r.stat))].sort(), [rows]);
  const allWeeks = useMemo(() => [...new Set(rows.map((r) => r.week))].sort((a, b) => a - b), [rows]);
  const allBooks = useMemo(() => {
    const m = new Map<string, { key: string; label: string; bettable: boolean }>();
    for (const r of rows) {
      const cur = m.get(r.book);
      if (!cur) m.set(r.book, { key: r.book, label: r.bookLabel, bettable: r.bettable });
      else if (!r.bettable) cur.bettable = false;
    }
    return [...m.values()].sort((a, b) => Number(b.bettable) - Number(a.bettable) || a.label.localeCompare(b.label));
  }, [rows]);
  const slotChoices = useMemo(() => (includeRecon ? SLOT_ORDER : LIVE_SLOTS), [includeRecon]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const choosePreset = (id: string) => {
    setPresetId(id);
    setFilters(presetFilters(id));
  };
  const drill = (d: Drill) => setFilters((f) => ({ ...f, ...d }));
  const toggleReconSlots = (on: boolean) => {
    setIncludeRecon(on);
    // Turning the reconstructions on adds them to the captures counted; off takes them out.
    setFilters((f) => ({ ...f, slots: on ? SLOT_ORDER.slice() : (f.slots ?? LIVE_SLOTS).filter((s) => LIVE_SLOTS.includes(s)) }));
  };

  if (err) return <main className="p-4 text-red-400">Failed to load paper-trading data: {err}. Run <code>npm run build:paper</code>.</main>;
  if (!live) return <div className="p-4 text-slate-400">Loading candidate bets…</div>;
  if (live.meta.empty || liveRows.length === 0) {
    return (
      <div className="space-y-6">
        <Explainer />
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-center text-sm text-slate-400">
          No candidate bets yet. Run <code className="text-slate-300">npm run capture-props</code>, then <code className="text-slate-300">npm run build:paper</code>.
        </div>
      </div>
    );
  }

  const byStat = groupSummaries(bets, (b: Bet) => b.stat, { completeWeeks, label: statLabel });
  const bySide = groupSummaries(bets, (b: Bet) => b.side, { completeWeeks, label: (k: string) => (k === "over" ? "Over" : "Under") });
  const byStatSide = groupSummaries(bets, (b: Bet) => `${b.stat}|${b.side}`, { completeWeeks, label: (k: string) => { const [s, sd] = k.split("|"); return `${statLabel(s)} — ${sd}`; } });
  const byBook = groupSummaries(bets, (b: Bet) => b.book, { completeWeeks, label: (k: string) => allBooks.find((x) => x.key === k)?.label ?? k });
  const byWeek = (groupSummaries(bets, (b: Bet) => String(b.week), { completeWeeks, label: (k: string) => `Week ${k}` })).sort((a, b) => Number(a.key) - Number(b.key));
  const byOdds = groupSummaries(bets, (b: Bet) => oddsBucket(b.dec), { completeWeeks });
  const byEdge = (groupSummaries(bets, (b: Bet) => edgeBucket(b.edge ?? 0), { completeWeeks })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const byRung = groupSummaries(bets, (b: Bet) => rungBucket(b.rung), { completeWeeks }).sort((a, b) => RUNG_BUCKETS.findIndex(([l]) => l === a.key) - RUNG_BUCKETS.findIndex(([l]) => l === b.key));
  const bySlot = (groupSummaries(bets, (b: Bet) => b.slot, { completeWeeks, label: (k: string) => SLOT_LABELS[k] ?? k })).sort((a, b) => SLOT_ORDER.indexOf(a.key) - SLOT_ORDER.indexOf(b.key));

  return (
    <div className="space-y-6">
      <Explainer />

      <Presets presetId={presetId} onChoose={choosePreset} />

      <FilterPanel
        f={filters}
        set={(p) => {
          setPresetId("custom");
          set(p);
        }}
        allStats={allStats}
        allWeeks={allWeeks}
        allBooks={allBooks}
        slotChoices={slotChoices}
        includeRecon={includeRecon}
        reconLoading={reconLoading}
        onRecon={(on) => {
          setPresetId("custom");
          toggleReconSlots(on);
        }}
        sharpBooks={live.meta.sharpBooks}
      />

      <Drilled f={filters} allBooks={allBooks} onClear={(d) => drill(d)} />

      <Scorecard s={total} reconBets={bets.filter((b) => !LIVE_SLOTS.includes(b.slot)).length} />

      <WeeklyPath groups={byWeek} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown title="By stat" first="Stat" groups={byStat} onPick={(k) => drill({ stats: [k] })} />
        <Breakdown title="Over vs under" first="Side" groups={bySide} onPick={(k) => drill({ sides: k as "over" | "under" })} />
      </div>
      <Breakdown title="Over vs under, per market" first="Market" groups={byStatSide} onPick={(k) => { const [s, sd] = k.split("|"); drill({ stats: [s], sides: sd as "over" | "under" }); }} wide />
      <div className="grid gap-4 lg:grid-cols-2">
        <Breakdown title="By book" first="Book" groups={byBook} onPick={(k) => drill({ books: [k], bettableOnly: allBooks.find((b) => b.key === k)?.bettable === false ? false : filters.bettableOnly })} />
        <Breakdown title="By odds" first="Odds" groups={byOdds} />
        <Breakdown title="By edge size" first="Edge" groups={byEdge} />
        <Breakdown title="By distance from the main line" first="Rung" groups={byRung} />
        <Breakdown title="By capture" first="Capture" groups={bySlot} onPick={(k) => drill({ slots: [k] })} />
        <Breakdown title="By week" first="Week" groups={byWeek} onPick={(k) => drill({ weeks: [Number(k)] })} />
      </div>

      <BetLog bets={bets} onOpenLine={onOpenLine} />

      <Notes />
    </div>
  );
}

// ---- Explainer --------------------------------------------------------------------

function Explainer() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-xs leading-relaxed text-slate-300">
      <h2 className="mb-1 text-sm font-semibold text-slate-100">Filtered paper trading</h2>
      <p>
        Every candidate bet on the boards we captured at the time, with the choosing left to you: which books, which odds, which side,
        whether to bet every rung of a ladder or only the best one, whether to shop for the best price, and whether the sharp books agree.
        It starts on <b>Realistic</b> — odds between {DEFAULT_ODDS_MIN} and +{DEFAULT_ODDS_MAX}, lines at least three books quote, one bet per player and stat at
        the best rung and price, placed at the first capture where it qualifies — and every control can be changed. Click any row in a
        table to drill into it.
      </p>
      <p className="mt-2 text-slate-400">
        Stakes are one unit flat. <b>Live captures only</b> by default (Tuesday, Thursday and Saturday): the reconstructed opening and closing boards are priced from the
        week&apos;s final projection and flatter every strategy, so they are off until you turn them on.
      </p>
    </div>
  );
}

function Notes() {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 text-[11px] leading-relaxed text-slate-500">
      <p className="mb-1 font-medium text-slate-400">How to read this</p>
      <ul className="list-disc space-y-1 pl-4">
        <li>
          <b>Edge basis.</b> <i>Projection</i> is what the RotoWire projection alone says against the book&apos;s price. <i>Pool</i> is the books&apos; weighted consensus with the
          projection&apos;s fitted share (the live pipeline&apos;s price, which is mostly the books, so it finds few edges). <i>Sharp</i> is the sharp books&apos; fair price alone: an edge there needs no
          projection at all.
        </li>
        <li>
          <b>Sharp confirmation</b> needs a sharp book (Pinnacle, Circa) to have quoted the exact line. Most alternate rungs have none, so turning it on removes them.
        </li>
        <li>
          <b>CLV</b> is the market&apos;s closing fair price of your side (the other books, at least two) minus the price you took. A beat rate under 50% means the market moved away from the bets.
        </li>
        <li>
          <b>Pending.</b> A bet with no stat line is either not played yet or on a player the actuals feed omitted (it drops all-zero lines). In a finished week the conservative ROI counts every such
          over as a loss and voids every such under.
        </li>
        <li>
          Reference books (Pinnacle) are priced but cannot be staked; they are off unless you untick &ldquo;only books you can bet at&rdquo;. Bets on one player are correlated, so every band is if anything too narrow.
        </li>
      </ul>
    </div>
  );
}

// ---- Presets ------------------------------------------------------------------------

function Presets({ presetId, onChoose }: { presetId: string; onChoose: (id: string) => void }) {
  const active = PRESETS.find((p) => p.id === presetId);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-slate-400">Start from:</span>
        {PRESETS.map((p: Preset) => (
          <button
            key={p.id}
            onClick={() => onChoose(p.id)}
            className={`rounded px-3 py-1 text-xs font-medium transition ${presetId === p.id ? "bg-brand-red text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}
          >
            {p.label}
          </button>
        ))}
        {presetId === "custom" && <span className="text-xs text-slate-500">custom — changed from a preset</span>}
      </div>
      {active && <p className="text-[11px] leading-relaxed text-slate-500">{active.description}</p>}
    </div>
  );
}

// ---- Filter panel ----------------------------------------------------------------------

function FilterPanel({
  f, set, allStats, allWeeks, allBooks, slotChoices, includeRecon, reconLoading, onRecon, sharpBooks,
}: {
  f: Filters;
  set: (p: Partial<Filters>) => void;
  allStats: string[];
  allWeeks: number[];
  allBooks: { key: string; label: string; bettable: boolean }[];
  slotChoices: string[];
  includeRecon: boolean;
  reconLoading: boolean;
  onRecon: (on: boolean) => void;
  sharpBooks: string[];
}) {
  const sel = <T,>(list: T[] | null, all: T[], v: T): T[] | null => {
    const cur = list ?? all;
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    return next.length === all.length ? null : next;
  };
  const visibleBooks = allBooks.filter((b) => !f.bettableOnly || b.bettable);
  return (
    <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <OddsRange min={f.oddsMin} max={f.oddsMax} onChange={(oddsMin, oddsMax) => set({ oddsMin, oddsMax })} />

        <Field label="Edge basis">
          <select value={f.basis} onChange={(e) => set({ basis: e.target.value as Filters["basis"] })} className={inputCls}>
            <option value="projection">Projection vs the book&apos;s price</option>
            <option value="pool">Pool (books + projection share)</option>
            <option value="sharp">Sharp books&apos; price</option>
          </select>
        </Field>

        <Field label="Edge at least / at most (%)">
          <div className="flex gap-2">
            <NumberInput value={f.minEdge * 100} step={0.5} min={3} onChange={(v) => set({ minEdge: Math.max(3, v ?? 3) / 100 })} className={inputCls} />
            <NumberInput value={f.maxEdge === null ? null : f.maxEdge * 100} step={1} min={0} placeholder="no cap" onChange={(v) => set({ maxEdge: v === null ? null : v / 100 })} className={inputCls} />
          </div>
        </Field>

        <Field label="Side">
          <Segmented value={f.sides} options={[["both", "Both"], ["over", "Over"], ["under", "Under"]]} onChange={(v) => set({ sides: v as Filters["sides"] })} />
        </Field>

        <Field label="Ladders">
          <select value={f.ladder} onChange={(e) => set({ ladder: e.target.value as Filters["ladder"] })} className={inputCls}>
            <option value="best">Best rung per player, stat and side</option>
            <option value="all">Every qualifying rung</option>
          </select>
        </Field>

        <Field label="Timing">
          <select value={f.timing} onChange={(e) => set({ timing: e.target.value as Filters["timing"] })} className={inputCls}>
            <option value="first">First capture where it qualifies</option>
            <option value="every">Every capture (counts a market up to 3×)</option>
          </select>
        </Field>

        <Field label="Books on the exact line, at least">
          <NumberInput value={f.minBooks} step={1} min={1} onChange={(v) => set({ minBooks: Math.max(1, Math.round(v ?? 1)) })} className={inputCls} />
        </Field>

        <Field label="Distance from the main line, at most">
          <NumberInput value={f.maxRung} step={1} min={0} placeholder="any" onChange={(v) => set({ maxRung: v === null ? null : Math.max(0, Math.round(v)) })} className={inputCls} />
        </Field>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Check checked={f.shop} onChange={(v) => set({ shop: v })} label="Shop for the best price among the books chosen" />
        <Check checked={f.bettableOnly} onChange={(v) => set({ bettableOnly: v })} label="Only books you can bet at" />
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input type="checkbox" checked={f.sharpConfirm !== null} onChange={(e) => set({ sharpConfirm: e.target.checked ? 0 : null })} />
          Sharp books don&apos;t contradict the price
          {f.sharpConfirm !== null && (
            <span className="flex items-center gap-1 text-slate-400">
              tolerance
              <NumberInput value={f.sharpConfirm * 100} step={0.5} onChange={(v) => set({ sharpConfirm: (v ?? 0) / 100 })} className={`${inputCls} w-16`} />
              pts
            </span>
          )}
        </label>
        <label className="flex items-center gap-2 text-xs text-amber-300/90">
          <input type="checkbox" checked={includeRecon} onChange={(e) => onRecon(e.target.checked)} />
          Include reconstructed opening/closing boards{reconLoading ? " (loading…)" : ""}
        </label>
      </div>
      {includeRecon && (
        <p className="rounded border border-amber-900/60 bg-amber-950/30 p-2 text-[11px] leading-relaxed text-amber-200/90">
          The opening and closing boards are reconstructions: each book&apos;s opening price is posted at a different moment and the projection on them is the week&apos;s final one, so they flatter every
          strategy. They are here to reproduce the older Paper Trading numbers and for sample size, not as evidence. Compare the By capture table below.
        </p>
      )}

      <ChipRow label="Books" note={`sharp: ${sharpBooks.slice(0, 2).join(", ")}`}>
        {visibleBooks.map((b) => (
          <Chip key={b.key} on={f.books === null || f.books.includes(b.key)} onClick={() => set({ books: sel(f.books, visibleBooks.map((x) => x.key), b.key) })} title={b.bettable ? "" : "Reference book: priced but cannot be staked"}>
            {b.label}
            {b.bettable ? "" : " (ref)"}
          </Chip>
        ))}
        <MiniButton onClick={() => set({ books: ["fanduel", "draftkings", "pinnacle", "circasports"], bettableOnly: false })}>Sharper only</MiniButton>
        <MiniButton onClick={() => set({ books: null })}>All</MiniButton>
      </ChipRow>

      <ChipRow label="Stats">
        {allStats.map((s) => (
          <Chip key={s} on={f.stats === null || f.stats.includes(s)} onClick={() => set({ stats: sel(f.stats, allStats, s) })}>
            {statLabel(s)}
          </Chip>
        ))}
        <MiniButton onClick={() => set({ stats: null })}>All</MiniButton>
      </ChipRow>

      <div className="grid gap-4 md:grid-cols-2">
        <ChipRow label="Weeks">
          {allWeeks.map((w) => (
            <Chip key={w} on={f.weeks === null || f.weeks.includes(w)} onClick={() => set({ weeks: sel(f.weeks, allWeeks, w) })}>
              {w}
            </Chip>
          ))}
          <MiniButton onClick={() => set({ weeks: null })}>All</MiniButton>
        </ChipRow>
        <ChipRow label="Captures">
          {slotChoices.map((s) => (
            <Chip key={s} on={(f.slots ?? slotChoices).includes(s)} onClick={() => set({ slots: sel(f.slots, slotChoices, s) })}>
              {SLOT_LABELS[s] ?? s}
            </Chip>
          ))}
        </ChipRow>
      </div>
    </div>
  );
}

const inputCls = "w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-400">{label}</div>
      {children}
    </div>
  );
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex overflow-hidden rounded border border-slate-700">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={`flex-1 px-2 py-1 text-xs ${value === v ? "bg-brand-red text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ChipRow({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-400">
        {label}
        {note ? <span className="ml-2 font-normal text-slate-600">{note}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className={`rounded px-2 py-0.5 text-[11px] transition ${on ? "bg-slate-600 text-white" : "bg-slate-800 text-slate-500 line-through hover:bg-slate-700"}`}>
      {children}
    </button>
  );
}

function MiniButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:bg-slate-800">
      {children}
    </button>
  );
}

// A number box that lets you type freely and only commits a value that parses,
// so clearing it to retype does not snap back to the old number mid-keystroke.
function NumberInput({
  value, onChange, step, min, placeholder, className,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(Math.round(value * 1000) / 1000));
  useEffect(() => {
    setText(value === null ? "" : String(Math.round(value * 1000) / 1000));
  }, [value]);
  return (
    <input
      type="number"
      value={text}
      step={step}
      min={min}
      placeholder={placeholder}
      className={className}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value === "") return onChange(null);
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

// The odds range. American odds have a gap between -100 and +100, so each bound
// is validated as a real price before it is applied, and the range can be widened
// or narrowed freely (the data holds -1000 to +3000).
function OddsRange({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  const [lo, setLo] = useState(String(min));
  const [hi, setHi] = useState(String(max));
  useEffect(() => {
    setLo(String(min));
    setHi(String(max));
  }, [min, max]);
  const loN = Number(lo);
  const hiN = Number(hi);
  const loOk = lo !== "" && isAmerican(loN);
  const hiOk = hi !== "" && isAmerican(hiN);
  const commit = (a: string, b: string) => {
    const x = Number(a);
    const y = Number(b);
    if (a !== "" && b !== "" && isAmerican(x) && isAmerican(y)) onChange(x, y);
  };
  const isDefault = min === DEFAULT_ODDS_MIN && max === DEFAULT_ODDS_MAX;
  return (
    <Field label="Odds, shortest to longest (American)">
      <div className="flex items-center gap-2">
        <input
          value={lo}
          onChange={(e) => {
            setLo(e.target.value);
            commit(e.target.value, hi);
          }}
          className={`${inputCls} ${loOk ? "" : "border-red-500"}`}
          inputMode="numeric"
        />
        <span className="text-xs text-slate-500">to</span>
        <input
          value={hi}
          onChange={(e) => {
            setHi(e.target.value);
            commit(lo, e.target.value);
          }}
          className={`${inputCls} ${hiOk ? "" : "border-red-500"}`}
          inputMode="numeric"
        />
      </div>
      <div className="mt-1 text-[10px] text-slate-600">
        {loOk && hiOk ? (isDefault ? "default range" : "") : "enter a price of at least 100 either side of zero"}
        {!isDefault && (
          <button className="ml-1 text-slate-400 underline" onClick={() => onChange(DEFAULT_ODDS_MIN, DEFAULT_ODDS_MAX)}>
            back to {DEFAULT_ODDS_MIN} / +{DEFAULT_ODDS_MAX}
          </button>
        )}
      </div>
    </Field>
  );
}

// ---- Drill-down breadcrumb ----------------------------------------------------------------

function Drilled({ f, allBooks, onClear }: { f: Filters; allBooks: { key: string; label: string }[]; onClear: (d: Drill) => void }) {
  const chips: { label: string; clear: Drill }[] = [];
  if (f.stats) chips.push({ label: `Stat: ${f.stats.map(statLabel).join(", ")}`, clear: { stats: null } });
  if (f.sides !== "both") chips.push({ label: `Side: ${f.sides}`, clear: { sides: "both" } });
  if (f.books) chips.push({ label: `Book: ${f.books.map((k) => allBooks.find((b) => b.key === k)?.label ?? k).join(", ")}`, clear: { books: null } });
  if (f.weeks) chips.push({ label: `Week: ${f.weeks.join(", ")}`, clear: { weeks: null } });
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-400">Drilled into:</span>
      {chips.map((c) => (
        <button key={c.label} onClick={() => onClear(c.clear)} className="rounded bg-brand-red/20 px-2 py-0.5 text-brand-red hover:bg-brand-red/30">
          {c.label} ✕
        </button>
      ))}
      <button onClick={() => onClear({ stats: null, sides: "both", books: null, weeks: null })} className="text-slate-500 underline">
        clear all
      </button>
    </div>
  );
}

// ---- Scorecard -------------------------------------------------------------------------------

function Scorecard({ s, reconBets }: { s: Summary; reconBets: number }) {
  const v = verdict(s);
  const need = s.roi !== null && s.perBetSd !== null ? betsToResolve(s.roi, s.perBetSd) : null;
  const need5 = s.perBetSd !== null ? betsToResolve(0.05, s.perBetSd) : null;
  // A verdict that leans on reconstructed boards is not one: those boards flatter every strategy.
  const tainted = reconBets > 0;
  const tone = tainted ? "text-amber-300" : v === "positive" ? "text-green-300" : v === "negative" ? "text-red-300" : "text-slate-300";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title="Bets" value={s.bets.toLocaleString()} sub={`${s.settled.toLocaleString()} settled · ${s.push} push · ${s.unplayed + s.noLine} pending`} />
        <Card title="ROI" value={spct(s.roi)} sub={s.roiBand === null ? "no settled bets" : `±${pct(s.roiBand)} at 95%`} tone={s.roi} />
        <Card title="P&L" value={units(s.pnl)} sub={`on ${s.settled.toLocaleString()}u staked · win ${pct(s.winRate, 0)}`} tone={s.pnl} />
        <Card
          title="Closing line value"
          value={s.clv ? pct(s.clv.beatRate, 0) : "—"}
          sub={s.clv ? `beat the close · avg ${spct(s.clv.avg, 1)} · ${s.clv.n} measurable` : "no market close to compare"}
          tone={s.clv ? s.clv.beatRate - 0.5 : null}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card title="Conservative ROI" value={spct(s.roiConservative)} sub={`pending in finished weeks: overs lost, unders void (${s.noLine})`} tone={s.roiConservative} small />
        <Card title="Average price" value={decToAmerican(s.avgDecimal)} sub="mean decimal odds, shown as American" small />
        <Card title="Average edge" value={pct(s.avgEdge)} sub="under the chosen price basis" small />
        <Card
          title="Verdict"
          value={tainted ? `${v}, but not evidence` : v}
          sub={tainted ? `${reconBets.toLocaleString()} of these bets are on reconstructed boards, which flatter every strategy. Untick them for a verdict.` : `needs ${MIN_BETS_FOR_A_VERDICT}+ settled bets and a band that excludes zero`}
          small
          toneClass={tone}
        />
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-[11px] leading-relaxed text-slate-400">
        {need !== null && s.roi !== null && (
          <>
            Seeing an ROI of <b className="text-slate-300">{spct(s.roi)}</b> at two standard errors takes about <b className="text-slate-300">{need.toLocaleString()}</b> settled bets; this filter has {s.settled.toLocaleString()}.{" "}
          </>
        )}
        {need5 !== null && (
          <>
            A <b className="text-slate-300">5%</b> edge would take about <b className="text-slate-300">{need5.toLocaleString()}</b>.{" "}
          </>
        )}
        Narrowing a filter always shrinks the sample, so a better-looking ROI on fewer bets is usually the filter finding noise.
      </div>
    </div>
  );
}

function Card({ title, value, sub, tone, small, toneClass }: { title: string; value: string; sub: string; tone?: number | null; small?: boolean; toneClass?: string }) {
  const color = toneClass ?? (tone === null || tone === undefined ? "text-slate-100" : tone > 0 ? "text-green-300" : tone < 0 ? "text-red-300" : "text-slate-100");
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="text-[11px] font-medium text-slate-400">{title}</div>
      <div className={`${small ? "text-base" : "text-2xl"} font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{sub}</div>
    </div>
  );
}

// ---- Path and breakdowns ---------------------------------------------------------------------

function WeeklyPath({ groups }: { groups: Group[] }) {
  if (groups.length < 2) return null;
  let run = 0;
  const data = groups.map((g) => {
    run += g.summary.pnl;
    return { week: `Wk ${g.key}`, pnl: Number(g.summary.pnl.toFixed(2)), running: Number(run.toFixed(2)) };
  });
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
      <div className="mb-2 text-xs font-medium text-slate-300">Cumulative P&amp;L by week (units)</div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="week" stroke="#64748b" fontSize={11} />
            <YAxis stroke="#64748b" fontSize={11} />
            <ReferenceLine y={0} stroke="#475569" />
            <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 12 }} />
            <Line type="monotone" dataKey="running" name="Running" stroke="#F22E45" strokeWidth={2} dot />
            <Line type="monotone" dataKey="pnl" name="That week" stroke="#64748b" strokeDasharray="4 3" dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Breakdown({ title, first, groups, onPick, wide }: { title: string; first: string; groups: Group[]; onPick?: (key: string) => void; wide?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-lg border border-slate-800 ${wide ? "" : ""}`}>
      <div className="flex items-baseline justify-between border-b border-slate-800 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-300">
        <span>{title}</span>
        {onPick && <span className="text-[10px] font-normal text-slate-600">click a row to drill in</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-left text-slate-400">
            <tr>
              <th className="px-2 py-1.5">{first}</th>
              <th className="px-2 py-1.5 text-right">Bets</th>
              <th className="px-2 py-1.5 text-right">Win%</th>
              <th className="px-2 py-1.5 text-right">ROI</th>
              <th className="px-2 py-1.5 text-right">±95%</th>
              <th className="px-2 py-1.5 text-right">P&amp;L</th>
              <th className="px-2 py-1.5 text-right" title="share of bets that beat the market's close">CLV beat</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const s = g.summary;
              return (
                <tr key={g.key} onClick={onPick ? () => onPick(g.key) : undefined} className={`border-b border-slate-800/40 ${onPick ? "cursor-pointer hover:bg-slate-800/40" : ""}`}>
                  <td className="px-2 py-1.5 text-slate-200">{g.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{s.bets.toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{pct(s.winRate, 0)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${s.roi === null ? "text-slate-500" : s.roi >= 0 ? "text-green-400" : "text-red-400"}`}>{spct(s.roi)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{s.roiBand === null ? "—" : `±${(s.roiBand * 100).toFixed(0)}`}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums ${s.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>{units(s.pnl)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-slate-400">{s.clv ? pct(s.clv.beatRate, 0) : "—"}</td>
                </tr>
              );
            })}
            {groups.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                  No bets under these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Bet log ----------------------------------------------------------------------------------

type SortKey = "week" | "edge" | "odds" | "pnl" | "clv";

function BetLog({ bets, onOpenLine }: { bets: Bet[]; onOpenLine?: (t: LineTarget) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "week", dir: 1 });
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(50);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = bets.filter((b) => (status === "all" || b.status === status) && (needle === "" || b.name.toLowerCase().includes(needle)));
    const val = (b: Bet): number => (sort.key === "week" ? b.week : sort.key === "edge" ? b.edge ?? -1 : sort.key === "odds" ? b.dec : sort.key === "pnl" ? b.pnl ?? -99 : b.clv ?? -99);
    return [...list].sort((a, b) => (val(a) - val(b)) * sort.dir);
  }, [bets, sort, q, status]);

  const head = (key: SortKey, label: string, right = true) => (
    <th className={`cursor-pointer select-none px-3 py-2 ${right ? "text-right" : ""}`} onClick={() => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "week" ? 1 : -1 }))}>
      {label}
      {sort.key === key ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900/80 px-3 py-2">
        <span className="text-xs font-medium text-slate-300">Bet log</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a player" className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-300">
          <option value="all">All statuses</option>
          <option value="won">Won</option>
          <option value="lost">Lost</option>
          <option value="push">Push</option>
          <option value="pending">Pending</option>
        </select>
        <span className="ml-auto text-[11px] text-slate-500">{Math.min(limit, shown.length)} of {shown.length.toLocaleString()} shown</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-900/60 text-left text-slate-400">
            <tr>
              {head("week", "Wk", false)}
              <th className="px-3 py-2">Capture</th>
              <th className="px-3 py-2">Player</th>
              <th className="px-3 py-2">Stat</th>
              <th className="px-3 py-2 text-right">Line</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2">Book</th>
              {head("odds", "Odds")}
              <th className="px-3 py-2 text-right" title="what the book's odds imply">Price</th>
              <th className="px-3 py-2 text-right">Proj</th>
              <th className="px-3 py-2 text-right">Sharp</th>
              {head("edge", "Edge")}
              <th className="px-3 py-2 text-right" title="books quoting this exact line">Books</th>
              <th className="px-3 py-2 text-right">Actual</th>
              <th className="px-3 py-2">Status</th>
              {head("pnl", "P&L")}
              {head("clv", "CLV")}
              {onOpenLine ? <th className="px-3 py-2" /> : null}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((b, i) => (
              <tr key={`${b.week}-${b.slot}-${b.playerId}-${b.stat}-${b.line}-${b.side}-${b.book}-${i}`} className="border-b border-slate-800/40 hover:bg-slate-800/40">
                <td className="px-3 py-2 tabular-nums text-slate-400">{b.week}</td>
                <td className="px-3 py-2 text-slate-500">{(SLOT_LABELS[b.slot] ?? b.slot).replace(" (reconstructed)", "*")}</td>
                <td className="px-3 py-2 text-slate-200">
                  {b.name} <span className="text-slate-500">({b.team})</span>
                </td>
                <td className="px-3 py-2 text-slate-300">{statLabel(b.stat)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300" title={rungLabel(b.rung)}>
                  {b.line}
                  {b.rung !== 0 && <span className="ml-1 text-slate-600">{b.rung > 0 ? "+" : ""}{b.rung}</span>}
                </td>
                <td className="px-3 py-2 text-slate-300">{b.side}</td>
                <td className="px-3 py-2 text-slate-400">{b.bookLabel}{b.bettable ? "" : " (ref)"}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">{american(b.odds)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">{pct(b.implied)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-blue-300">{pct(b.pProj)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">{pct(b.pSharp)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-emerald-300">{pct(b.edge)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{b.nBooks}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-300">{b.actual ?? "—"}</td>
                <td className="px-3 py-2"><StatusBadge status={b.status} /></td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {b.pnl === null ? "—" : <span className={b.pnl >= 0 ? "text-green-400" : "text-red-400"}>{units(b.pnl)}</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-400">{b.clv === null ? "—" : spct(b.clv)}</td>
                {onOpenLine ? (
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => onOpenLine({ week: b.week, slot: b.slot, playerId: b.playerId, stat: b.stat, line: b.line })}
                      title="See every line and price for this player, as it stood in the capture this bet came from"
                      className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300 transition hover:bg-slate-700"
                    >
                      Price ▸
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <div className="border-t border-slate-800 p-2 text-center">
          <button onClick={() => setLimit((l) => l + 200)} className="rounded bg-slate-800 px-3 py-1 text-xs text-slate-300 hover:bg-slate-700">
            Show 200 more
          </button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "won" ? "bg-green-900/50 text-green-300" : status === "lost" ? "bg-red-900/50 text-red-300" : status === "push" ? "bg-slate-700 text-slate-300" : "bg-amber-900/40 text-amber-300";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{status}</span>;
}
