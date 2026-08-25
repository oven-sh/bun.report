import { describe, expect, test } from "bun:test";
import { FloodGate } from "../backend/flood-gate";
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

  test("buckets are per commit/os/arch/canary", () => {
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
});
