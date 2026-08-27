import { describe, expect, spyOn, test } from "bun:test";
import { FloodGate, parseBlocklist } from "../backend/flood-gate";
import type { Parse, Remap } from "../lib/parser";

function parse(cache_key: string, os = "macos", arch = "aarch64", is_canary = false): Parse {
  return { cache_key, os, arch, is_canary } as unknown as Parse;
}
function remap(oid = "aaaaaaaaa"): Remap {
  return { commit: { oid, pr: null } } as unknown as Remap;
}

describe("FloodGate", () => {
  test("repeats of the same stack are always forwarded", () => {
    const gate = new FloodGate(3, () => 0);
    for (let i = 0; i < 5000; i++) expect(gate.shouldForward(parse("k"), remap())).toBe(true);
  });

  test("new stacks beyond the limit are dropped; known stacks still pass", () => {
    const gate = new FloodGate(1000, () => 0);
    for (let i = 0; i < 1000; i++) expect(gate.shouldForward(parse(`k${i}`), remap())).toBe(true);
    expect(gate.shouldForward(parse("k1000"), remap())).toBe(false);
    expect(gate.shouldForward(parse("k1001"), remap())).toBe(false);
    expect(gate.shouldForward(parse("k0"), remap())).toBe(true);
    expect(gate.shouldForward(parse("k999"), remap())).toBe(true);
  });

  test("buckets are per commit/os/arch/environment", () => {
    const gate = new FloodGate(1, () => 0);
    expect(gate.shouldForward(parse("a"), remap("111111111"))).toBe(true);
    expect(gate.shouldForward(parse("b"), remap("111111111"))).toBe(false);
    expect(gate.shouldForward(parse("b"), remap("222222222"))).toBe(true);
    expect(gate.shouldForward(parse("b", "windows"), remap("111111111"))).toBe(true);
    expect(gate.shouldForward(parse("b", "macos", "x86_64"), remap("111111111"))).toBe(true);
    expect(gate.shouldForward(parse("b", "macos", "aarch64", true), remap("111111111"))).toBe(true);
    expect(gate.shouldForward(parse("c"), remap("111111111"))).toBe(false);
  });

  test("limit resets each hour", () => {
    let now = 0;
    const gate = new FloodGate(1, () => now);
    expect(gate.shouldForward(parse("a"), remap())).toBe(true);
    expect(gate.shouldForward(parse("b"), remap())).toBe(false);
    now = 60 * 60 * 1000;
    expect(gate.shouldForward(parse("b"), remap())).toBe(true);
    expect(gate.shouldForward(parse("a"), remap())).toBe(false);
  });

  test("events without a cache_key are forwarded", () => {
    const gate = new FloodGate(0, () => 0);
    expect(gate.shouldForward({ os: "macos", arch: "aarch64" } as unknown as Parse, remap())).toBe(
      true,
    );
  });

  test("logs usage at rollover when a bucket reached half the limit", () => {
    let now = 0;
    const gate = new FloodGate(4, () => now);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      gate.shouldForward(parse("a"), remap());
      gate.shouldForward(parse("b"), remap());
      now = 60 * 60 * 1000;
      gate.shouldForward(parse("c"), remap());
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        "flood-gate: aaaaaaaaa/macos/aarch64/production used 2/4 distinct stacks in hour 0",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("logs dropped count at rollover", () => {
    let now = 0;
    const gate = new FloodGate(1, () => now);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      gate.shouldForward(parse("a"), remap());
      gate.shouldForward(parse("b"), remap());
      gate.shouldForward(parse("c"), remap());
      now = 60 * 60 * 1000;
      gate.shouldForward(parse("a"), remap());
      expect(warn.mock.calls.map((c) => c[0])).toEqual([
        "flood-gate: aaaaaaaaa/macos/aarch64/production exceeded 1 distinct stacks this hour; dropping new stacks",
        "flood-gate: aaaaaaaaa/macos/aarch64/production dropped 2 events in hour 0",
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test("blocklisted builds are never forwarded", () => {
    const gate = new FloodGate(
      1000,
      () => 0,
      parseBlocklist("1111111/macos/aarch64, 2222222/windows/x86_64"),
    );
    expect(gate.shouldForward(parse("a"), remap("111111111"))).toBe(false);
    expect(gate.shouldForward(parse("a"), remap("111111111"))).toBe(false);
    expect(gate.shouldForward(parse("a", "macos", "x86_64"), remap("111111111"))).toBe(true);
    expect(gate.shouldForward(parse("a", "linux"), remap("111111111"))).toBe(true);
    expect(gate.shouldForward(parse("a"), remap("333333333"))).toBe(true);
    expect(gate.shouldForward(parse("b", "windows", "x86_64"), remap("222222222"))).toBe(false);
  });

  test("parseBlocklist", () => {
    expect(parseBlocklist(undefined)).toEqual([]);
    expect(parseBlocklist("")).toEqual([]);
    expect(parseBlocklist(" abc/macos/aarch64 ,def/linux/x86_64,")).toEqual([
      ["abc", "macos", "aarch64"],
      ["def", "linux", "x86_64"],
    ]);
  });
});
