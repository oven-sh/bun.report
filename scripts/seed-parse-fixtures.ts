#!/usr/bin/env bun
/**
 * Generates the initial set of parse fixtures from a hard-coded matrix.
 *
 * These are *constructed* inputs that exercise the format. Real-world fixtures
 * captured from production should be added via `scripts/capture-fixture.ts`.
 *
 * Usage: bun scripts/seed-parse-fixtures.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildTraceString, type BuildTraceOpts } from "../test/helpers/encode";
import { parse } from "../lib/parser";

const out = path.join(import.meta.dir, "..", "test", "fixtures", "parse");
await mkdir(out, { recursive: true });

type Case = { name: string; opts: BuildTraceOpts };

const platforms: Array<[BuildTraceOpts["os"], BuildTraceOpts["arch"]]> = [
  ["windows", "x86_64"],
  ["windows", "x86_64_baseline"],
  ["windows", "aarch64"],
  ["macos", "x86_64"],
  ["macos", "x86_64_baseline"],
  ["macos", "aarch64"],
  ["linux", "x86_64"],
  ["linux", "x86_64_baseline"],
  ["linux", "aarch64"],
];

const cases: Case[] = [];

for (const tv of ["1", "2"] as const) {
  for (const [os, arch] of platforms) {
    cases.push({
      name: `v${tv}-${os}-${arch}-segfault`,
      opts: {
        version: "1.1.30",
        os,
        arch,
        command: "r",
        trace_version: tv,
        commitish: "abc1234",
        features: [3, 7],
        addresses: [
          { address: 0x10ab34, object: "bun" },
          { address: 0x20cd56, object: "bun" },
          { address: 0x30ef78, object: "bun" },
        ],
        reason: { kind: "segfault", addr_hi: 0, addr_lo: 0x6eadbeef },
      },
    });
  }
}

cases.push({
  name: "v1-macos-aarch64-panic-compressed",
  opts: {
    version: "1.1.30",
    os: "macos",
    arch: "aarch64",
    command: "i",
    trace_version: "1",
    commitish: "abc1234",
    features: [0, 0],
    addresses: [{ address: 0x1000, object: "bun" }],
    reason: { kind: "panic", message: "Integer overflow in allocator" },
  },
});

cases.push({
  name: "v1-linux-x86_64-with-js-and-unknown-frames",
  opts: {
    version: "1.1.30",
    os: "linux",
    arch: "x86_64",
    command: "t",
    trace_version: "1",
    commitish: "abc1234",
    addresses: [
      { address: 0x1111, object: "bun" },
      { address: 0, object: "js" },
      { address: 0, object: "js" },
      { address: 0x2222, object: "bun" },
      { address: 0, object: "?" },
      { address: 0x3333, object: "bun" },
    ],
    reason: { kind: "unreachable" },
  },
});

cases.push({
  name: "v1-linux-x86_64-foreign-object",
  opts: {
    version: "1.1.30",
    os: "linux",
    arch: "x86_64",
    command: "r",
    trace_version: "1",
    commitish: "abc1234",
    addresses: [
      { address: 0x1111, object: "bun" },
      { address: 0xabcd, object: "/libc.so.6" },
      { address: 0x2222, object: "bun" },
    ],
    reason: { kind: "stack_overflow" },
  },
});

cases.push({
  name: "v2-windows-x86_64-error-reason",
  opts: {
    version: "1.1.30",
    os: "windows",
    arch: "x86_64",
    command: "b",
    trace_version: "2",
    commitish: "abc1234",
    addresses: [{ address: 0x55aa, object: "bun" }],
    reason: { kind: "error", message: "ENOENT: no such file or directory" },
  },
});

cases.push({
  name: "v1-macos-aarch64-oom",
  opts: {
    version: "1.1.30",
    os: "macos",
    arch: "aarch64",
    command: "r",
    trace_version: "1",
    commitish: "abc1234",
    addresses: [
      { address: 0xaaaa, object: "bun" },
      { address: 0xbbbb, object: "bun" },
    ],
    reason: { kind: "oom" },
  },
});

cases.push({
  name: "v1-macos-aarch64-with-url-prefix",
  opts: {
    version: "1.1.30",
    os: "macos",
    arch: "aarch64",
    command: "r",
    trace_version: "1",
    commitish: "abc1234",
    addresses: [{ address: 0x1234, object: "bun" }],
    reason: { kind: "unreachable" },
  },
});

let written = 0;
for (const c of cases) {
  const input =
    c.name === "v1-macos-aarch64-with-url-prefix"
      ? "https://bun.report/" + buildTraceString(c.opts) + "/view"
      : buildTraceString(c.opts);
  const parsed = await parse(input);
  if (parsed == null) {
    console.error(`FAIL: ${c.name} did not parse`);
    console.error(`  input: ${input}`);
    process.exitCode = 1;
    continue;
  }
  const file = path.join(out, c.name + ".json");
  await writeFile(file, JSON.stringify({ description: c.name, input }, null, 2) + "\n");
  written++;
}

console.log(`wrote ${written}/${cases.length} parse fixtures to ${path.relative(process.cwd(), out)}`);
