import { describe, test, expect } from "bun:test";
import { parse } from "../lib/parser";
import { buildTraceString, encodeVlq, type BuildTraceOpts } from "./helpers/encode";
import { decodePart } from "../lib/vlq";

describe("vlq roundtrip", () => {
  for (const v of [0, 1, 2, 31, 32, 0x1234, 0x10ab34, 0x7fffffff]) {
    test(`0x${v.toString(16)}`, () => {
      const [dec, consumed] = decodePart(encodeVlq(v));
      expect(dec).toBe(v);
      expect(consumed).toBe(encodeVlq(v).length);
    });
  }
});

describe("parse(buildTraceString(x)) recovers x", () => {
  const cases: BuildTraceOpts[] = [
    {
      version: "1.1.30",
      os: "macos",
      arch: "aarch64",
      command: "r",
      trace_version: "1",
      commitish: "abc1234",
      features: [3, 7],
      addresses: [
        { address: 0x10ab34, object: "bun" },
        { address: 0x20cd56, object: "bun" },
        { address: 0x30ef78, object: "bun" },
      ],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0x6eadbeef },
    },
    {
      version: "1.2.0",
      os: "windows",
      arch: "x86_64",
      command: "i",
      trace_version: "2",
      commitish: "fedcba9",
      features: [0, 0],
      addresses: [
        { address: 0x1111, object: "bun" },
        { address: 0, object: "js" },
        { address: 0xabcd, object: "/libc.so.6" },
        { address: 0, object: "?" },
        { address: 0x2222, object: "bun" },
      ],
      reason: { kind: "unreachable" },
    },
    {
      version: "1.1.30",
      os: "linux",
      arch: "x86_64_baseline",
      command: "t",
      trace_version: "1",
      commitish: "0000000",
      addresses: [{ address: 0x42, object: "bun" }],
      reason: { kind: "panic", message: "Integer overflow in allocator" },
    },
  ];

  for (const c of cases) {
    test(`${c.os}-${c.arch} v${c.trace_version}`, async () => {
      const result = await parse(buildTraceString(c));
      expect(result).not.toBeNull();
      const p = result!;

      expect(p.version).toBe(c.version);
      expect(p.os).toBe(c.os);
      expect(p.arch).toBe(c.arch);
      expect(p.command).toBe(c.command);
      expect(p.commitish).toBe(c.commitish);
      expect(p.features).toEqual(c.features ?? [0, 0]);
      expect(p.is_canary).toBe(c.trace_version === "2");

      expect(p.addresses).toHaveLength(c.addresses.length);
      for (let i = 0; i < c.addresses.length; i++) {
        expect(p.addresses[i].address).toBe(c.addresses[i].address);
        const obj = c.addresses[i].object;
        expect(p.addresses[i].object).toBe(obj.startsWith("/") ? obj.slice(1) : obj);
      }

      if (c.reason.kind === "panic") expect(p.message).toBe(`panic: ${c.reason.message}`);
      if (c.reason.kind === "unreachable") expect(p.message).toContain("unreachable");
      if (c.reason.kind === "segfault") expect(p.message).toContain(c.reason.addr_lo.toString(16).toUpperCase());
    });
  }
});
