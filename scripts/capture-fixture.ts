#!/usr/bin/env bun
/**
 * Captures fixture(s) from a real bun.report trace string.
 *
 *   bun scripts/capture-fixture.ts <name> <trace-string-or-url> [--symbolize]
 *
 * Always writes test/fixtures/parse/<name>.json.
 * With --symbolize, also resolves debug info, runs the real symbolizer,
 * records its stdout, and writes test/fixtures/symbolize/<name>.json.
 *
 * After capturing, run `bun test --update-snapshots` to record expected output.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "../lib/parser";
import { adjustBunAddresses } from "../backend/symbolize";

const [name, input, ...flags] = process.argv.slice(2);
if (!name || !input) {
  console.error("usage: bun scripts/capture-fixture.ts <name> <trace-string-or-url> [--symbolize]");
  process.exit(1);
}
if (!/^[a-z0-9._-]+$/.test(name)) {
  console.error("name must match /^[a-z0-9._-]+$/");
  process.exit(1);
}

const root = path.join(import.meta.dir, "..");
const parseDir = path.join(root, "test", "fixtures", "parse");
const symDir = path.join(root, "test", "fixtures", "symbolize");
await mkdir(parseDir, { recursive: true });
await mkdir(symDir, { recursive: true });

const parsed = await parse(input);
if (parsed == null) {
  console.error("input did not parse (parse() returned null)");
  process.exit(1);
}

await writeFile(
  path.join(parseDir, name + ".json"),
  JSON.stringify({ description: name, input }, null, 2) + "\n",
);
console.log(`wrote test/fixtures/parse/${name}.json`);
console.log(`  os=${parsed.os} arch=${parsed.arch} addrs=${parsed.addresses.length}`);

if (!flags.includes("--symbolize")) {
  console.log("\nrun with --symbolize to also capture symbolizer stdout (requires debug-file access)");
  process.exit(0);
}

const { fetchDebugFile } = await import("../backend/debug-store");
const { llvm_symbolizer, pdb_addr2line } = await import("../backend/system-deps");
const { getCommit } = await import("../backend/git");

const commit = await getCommit(parsed.commitish);
if (!commit) {
  console.error(`could not resolve commitish ${parsed.commitish}`);
  process.exit(1);
}
const debug_info = await fetchDebugFile(parsed.os, parsed.arch, commit, parsed.is_canary);
if (!debug_info) {
  console.error(`no debug file for ${parsed.os}-${parsed.arch} @ ${commit.oid}`);
  process.exit(1);
}

const bun_addrs = adjustBunAddresses(parsed.addresses, parsed.os);
const cmd = [
  parsed.os === "windows" ? pdb_addr2line : llvm_symbolizer,
  "--exe",
  debug_info.file_path,
  ...(parsed.os !== "windows" ? ["--no-inlines", "--relative-address"] : ["--llvm"]),
  "-f",
  ...bun_addrs,
];
const subproc = Bun.spawn({ cmd, stdio: ["ignore", "pipe", "pipe"] });
const stdout = await Bun.readableStreamToText(subproc.stdout);
if ((await subproc.exited) !== 0) {
  console.error(await Bun.readableStreamToText(subproc.stderr));
  process.exit(1);
}

await writeFile(
  path.join(symDir, name + ".json"),
  JSON.stringify(
    { description: name, os: parsed.os, addresses: parsed.addresses, stdout },
    null,
    2,
  ) + "\n",
);
console.log(`wrote test/fixtures/symbolize/${name}.json`);
console.log("\nnext: bun test --update-snapshots");
