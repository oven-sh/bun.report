#!/usr/bin/env bun
import { $ } from "bun";
import { parse } from "../lib/parser";

const urlRe = /https?:\/\/bun\.report\/[^\s)\]"'<>`]+/g;

function verGte130(v: string) {
  const [a, b] = v.split(".").map(Number);
  return a > 1 || (a === 1 && b >= 3);
}

interface Row { input: string; version: string; os: string; arch: string; addrs: number; unk: number; foreign: number; reason: string; issue: number }
const seen = new Set<string>();
const rows: Row[] = [];

for (let page = 1; page <= 10; page++) {
  let res: any;
  try {
    res = await $`gh api -X GET search/issues -f q=${"repo:oven-sh/bun bun.report"} -f per_page=100 -f page=${page} -f sort=created -f order=desc`.json();
  } catch (e) {
    process.stderr.write(`page ${page} failed: ${e}\n`);
    break;
  }
  const items = res.items ?? [];
  if (items.length === 0) break;
  for (const it of items) {
    const body: string = it.body ?? "";
    for (const m of body.matchAll(urlRe)) {
      const trace = m[0]
        .replace(/^https?:\/\/bun\.report\//, "")
        .replace(/\/(view|ack|github)$/, "")
        .replace(/[.,;:]+$/, "");
      if (seen.has(trace)) continue;
      seen.add(trace);
      const p = await parse(trace).catch(() => null);
      if (!p || !verGte130(p.version)) continue;
      rows.push({
        input: trace,
        version: p.version,
        os: p.os,
        arch: p.arch,
        addrs: p.addresses.length,
        unk: p.addresses.filter(a => a.object === "?" || a.object === "js").length,
        foreign: p.addresses.filter(a => a.object !== "bun" && a.object !== "?" && a.object !== "js").length,
        reason: p.message.split("\n")[0].slice(0, 60),
        issue: it.number,
      });
    }
  }
  process.stderr.write(`page ${page}: ${rows.length} traces (>=1.3.0)\n`);
  await Bun.sleep(700);
}

await Bun.write(import.meta.dir + "/harvested.json", JSON.stringify(rows, null, 2));

const byOs: Record<string, number> = {};
for (const r of rows) byOs[r.os] = (byOs[r.os] ?? 0) + 1;
console.log(JSON.stringify({ total: rows.length, byOs }, null, 2));
