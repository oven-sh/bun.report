#!/usr/bin/env bun
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

interface Row { input: string; version: string; os: string; arch: string; addrs: number; unk: number; foreign: number; reason: string; issue: number }
const rows: Row[] = JSON.parse(await Bun.file(import.meta.dir + "/harvested.json").text());

const reasonClass = (r: string) =>
  r.startsWith("panic:") ? "panic" :
  r.startsWith("Segmentation") ? "segv" :
  r.startsWith("Illegal") ? "ill" :
  r.startsWith("Bus") ? "bus" :
  r.startsWith("Floating") ? "fpe" :
  r.startsWith("error:") ? "error" :
  r.includes("out of memory") ? "oom" :
  r.includes("Stack overflow") ? "so" :
  r.includes("unreachable") ? "unreachable" :
  "other";

const sizeClass = (n: number) => n <= 3 ? "xs" : n <= 8 ? "sm" : n <= 16 ? "md" : "lg";

// One pass per OS: greedily pick rows that introduce a new (reason, size, hasUnk,
// hasForeign, arch) signature, then top up to target with remaining unique inputs.
function selectForOs(os: string, target: number): Row[] {
  const pool = rows.filter(r => r.os === os);
  const sigs = new Set<string>();
  const picked: Row[] = [];
  const sig = (r: Row) => [reasonClass(r.reason), sizeClass(r.addrs), r.unk > 0, r.foreign > 0, r.arch].join("|");
  for (const r of pool) {
    const s = sig(r);
    if (!sigs.has(s)) { sigs.add(s); picked.push(r); }
    if (picked.length >= target) break;
  }
  for (const r of pool) {
    if (picked.length >= target) break;
    if (!picked.includes(r)) picked.push(r);
  }
  return picked.slice(0, target);
}

const selected = [
  ...selectForOs("macos", 33),
  ...selectForOs("linux", 34),
  ...selectForOs("windows", 33),
];

const out = path.join(import.meta.dir, "..", "test", "fixtures", "parse", "real");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

let i = 0;
for (const r of selected) {
  i++;
  const rc = reasonClass(r.reason);
  const flags = [r.unk > 0 ? "unk" : "", r.foreign > 0 ? "foreign" : ""].filter(Boolean).join("-");
  const name = `real-${String(i).padStart(3, "0")}-${r.os}-${r.arch}-${r.version}-${rc}-${sizeClass(r.addrs)}${flags ? "-" + flags : ""}`;
  await writeFile(
    path.join(out, name + ".json"),
    JSON.stringify({ description: name, source_issue: r.issue, input: r.input }, null, 2) + "\n",
  );
}

const byOs: Record<string, number> = {}, byReason: Record<string, number> = {}, bySize: Record<string, number> = {};
for (const r of selected) {
  byOs[r.os] = (byOs[r.os] ?? 0) + 1;
  byReason[reasonClass(r.reason)] = (byReason[reasonClass(r.reason)] ?? 0) + 1;
  bySize[sizeClass(r.addrs)] = (bySize[sizeClass(r.addrs)] ?? 0) + 1;
}
console.log(JSON.stringify({ selected: selected.length, byOs, byReason, bySize, withUnknown: selected.filter(r=>r.unk>0).length, withForeign: selected.filter(r=>r.foreign>0).length }, null, 2));
