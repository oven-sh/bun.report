#!/usr/bin/env bun
/**
 * Reads bun.report URLs/trace-strings (one per line, or freeform text containing
 * them) from a file or stdin, parses each, prints a distribution summary, and
 * writes parse fixtures under test/fixtures/parse/real/.
 *
 *   bun scripts/ingest-urls.ts <file>
 *   pbpaste | bun scripts/ingest-urls.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "../lib/parser";

const src = process.argv[2]
  ? await Bun.file(process.argv[2]).text()
  : await Bun.stdin.text();

const re = /(?:https?:\/\/bun\.report\/)?(\d+\.\d+\.\d+\/[A-Za-z0-9+/=_\-][^\s)"'<>`]+)/g;
const seen = new Set<string>();
const traces: string[] = [];
for (const m of src.matchAll(re)) {
  const t = m[1].replace(/\/(view|ack|github)$/, "").replace(/[.,;:]+$/, "");
  if (!seen.has(t)) { seen.add(t); traces.push(t); }
}

interface Row { input: string; os: string; arch: string; version: string; addrs: number; unk: number; reason: string }
const rows: Row[] = [];
const failed: string[] = [];
for (const t of traces) {
  const p = await parse(t).catch(() => null);
  if (!p) { failed.push(t); continue; }
  rows.push({
    input: t,
    os: p.os,
    arch: p.arch,
    version: p.version,
    addrs: p.addresses.length,
    unk: p.addresses.filter(a => a.object === "?" || a.object === "js").length,
    reason: p.message.split("\n")[0].slice(0, 50),
  });
}

const out = path.join(import.meta.dir, "..", "test", "fixtures", "parse", "real");
await mkdir(out, { recursive: true });
let n = 0;
for (const r of rows) {
  n++;
  const name = `real-${String(n).padStart(3, "0")}-${r.os}-${r.arch}-${r.version}`;
  await writeFile(
    path.join(out, name + ".json"),
    JSON.stringify({ description: name, input: r.input }, null, 2) + "\n",
  );
}

const byOs: Record<string, number> = {};
const byVer: Record<string, number> = {};
for (const r of rows) { byOs[r.os] = (byOs[r.os] ?? 0) + 1; byVer[r.version] = (byVer[r.version] ?? 0) + 1; }

console.log(`\nparsed ${rows.length}/${traces.length} (failed: ${failed.length})`);
console.log("by os  :", byOs);
console.log("by ver :", byVer);
const sizes = rows.map(r => r.addrs).sort((a,b)=>a-b);
console.log(`addrs  : min=${sizes[0]} med=${sizes[Math.floor(sizes.length/2)]} max=${sizes[sizes.length-1]}`);
console.log(`wrote ${rows.length} fixtures -> test/fixtures/parse/real/`);
if (failed.length) { console.log("\nfailed to parse:"); failed.forEach(f => console.log("  " + f)); }
