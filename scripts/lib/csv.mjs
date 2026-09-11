// Minimal CSV read/write shared by the capture/grade/build scripts. Matches
// the naive comma-split parser already used in build-data.mjs — every column
// in this project's CSVs is a plain number or short code, so no quoting/
// escaping is needed.
import { readFileSync } from "node:fs";

export function readCsv(path) {
  const text = readFileSync(path, "utf8").replace(/\r/g, "");
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cells[j];
    rows.push(obj);
  }
  return rows;
}

export function toCsv(columns, rows) {
  const out = [columns.join(",")];
  for (const row of rows) {
    out.push(columns.map((c) => (row[c] === undefined || row[c] === null ? "" : row[c])).join(","));
  }
  return out.join("\n") + "\n";
}
