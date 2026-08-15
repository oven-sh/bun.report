import { describe, test, expect } from "bun:test";
import { parse } from "../lib/parser";
import { buildTraceString, encodeHeader, encodeVlq, type BuildTraceOpts } from "./helpers/encode";
import { decodePart } from "../lib/vlq";
import { parseCacheKey } from "../lib/util";

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
    {
      version: "1.4.0",
      os: "linux",
      arch: "x86_64",
      command: "r",
      trace_version: "3",
      build_flags: 0,
      commitish: "33c2410",
      addresses: [{ address: 0x2f864f4, object: "bun" }],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0xdeadbeef | 0 },
      registers: {
        pc: { address: 0x2f864f4, object: "bun" },
        values: [0xdeadbeefn, 0x5eb3e780000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0xfffe000000000000n, 0xfffe000000000002n, 0x2f864f5n],
      },
    },
    {
      version: "1.4.0",
      os: "macos",
      arch: "aarch64",
      command: "_",
      trace_version: "3",
      build_flags: 1,
      commitish: "33c2410",
      addresses: [{ address: 0x1063487, object: "bun" }],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0xdeadbeef | 0 },
      registers: {
        pc: { address: 0x1063487, object: "bun" },
        values: Array.from({ length: 33 }, (_, i) => (i === 8 ? 0xdeadbeefn : BigInt(i))),
      },
    },
    // u64 halves of exactly 0x80000000 encode as VLQ(i32::MIN) = 'B', which
    // bun.report's decoder maps back to -0x80000000 → u32 0x80000000.
    {
      version: "1.4.0",
      os: "linux",
      arch: "x86_64",
      command: "r",
      trace_version: "3",
      build_flags: 0,
      commitish: "33c2410",
      addresses: [{ address: 0x42, object: "bun" }],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0x80000000 | 0 },
      registers: {
        pc: { address: 0x42, object: "bun" },
        values: [0x80000000n, 0xffffffff_80000000n, 0x80000000_00000000n, 0x80000000_80000000n],
      },
    },
    // v3 segfault with no fault context (e.g. unknown arch): `_A` block.
    {
      version: "1.4.0",
      os: "linux",
      arch: "aarch64",
      command: "r",
      trace_version: "3",
      build_flags: 0,
      commitish: "33c2410",
      addresses: [{ address: 0x1234, object: "bun" }],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0xdeadbeef | 0 },
      registers: { pc: null, values: [] },
    },
    // v3 non-fault reason: no register block.
    {
      version: "1.4.0",
      os: "linux",
      arch: "x86_64",
      command: "r",
      trace_version: "3",
      build_flags: 1,
      commitish: "33c2410",
      addresses: [{ address: 0x42, object: "bun" }],
      reason: { kind: "oom" },
    },
    // reason 'a' (SIGABRT): no address, no register block.
    {
      version: "1.4.0",
      os: "linux",
      arch: "aarch64",
      command: "r",
      trace_version: "1",
      commitish: "3a3f5d1",
      addresses: [
        { address: 0x12ab34, object: "bun" },
        { address: 0x56cd78, object: "bun" },
      ],
      reason: { kind: "abort" },
    },
    // reason 'b' (SIGTRAP): fault address encoded like reasons "2"–"5".
    {
      version: "1.4.0",
      os: "macos",
      arch: "aarch64",
      command: "r",
      trace_version: "2",
      commitish: "3a3f5d1",
      addresses: [{ address: 0x2f864f4, object: "bun" }],
      reason: { kind: "trap", addr_hi: 1, addr_lo: 0x02f864f4 },
    },
    // FreeBSD platform chars 'f'/'F'.
    {
      version: "1.4.0",
      os: "freebsd",
      arch: "aarch64",
      command: "a",
      trace_version: "1",
      commitish: "abc1234",
      addresses: [{ address: 0x4242, object: "bun" }],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0xdeadbeef | 0 },
    },
    // v3 stack-overflow (reason '7', no fault address): register block follows
    // immediately after the reason byte.
    {
      version: "1.4.0",
      os: "windows",
      arch: "aarch64",
      command: "r",
      trace_version: "3",
      build_flags: 1,
      commitish: "33c2410",
      addresses: [{ address: 0x1234, object: "bun" }],
      reason: { kind: "stack_overflow" },
      registers: {
        pc: { address: 0x444e6e8, object: "bun" },
        values: Array.from({ length: 33 }, (_, i) => BigInt(i)),
      },
    },
    // v4: build flags, then the debug id. A 20-byte sha1 build-id (ELF)...
    {
      version: "1.4.0",
      os: "linux",
      arch: "x86_64",
      command: "a",
      trace_version: "4",
      build_flags: 1,
      debug_id: "caac16c6401beba3fdd7e29cafe9bd212a0a23f8",
      commitish: "2c2ef7c",
      features: [96, 1048577],
      addresses: [
        { address: 0x2f864f4, object: "bun" },
        { address: 0, object: "?" },
        { address: 0x1234, object: "/libc.so.6" },
      ],
      reason: { kind: "panic", message: "invoked crashByPanic() handler" },
    },
    // ...a 16-byte PDB GUID (Windows), release build, with a foreign frame
    // after the id to show the VLQ stream is still aligned...
    {
      version: "1.4.0",
      os: "windows",
      arch: "x86_64",
      command: "t",
      trace_version: "4",
      build_flags: 0,
      debug_id: "e4509f66f3b4e4984c4c44205044422e",
      commitish: "605e221",
      addresses: [
        { address: 0x1111, object: "bun" },
        { address: 0x17344, object: "KERNEL32.DLL" },
      ],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0 },
    },
    // ...and an executable without an id (count 0), which must parse like a
    // v3 trace minus the register block.
    {
      version: "1.4.0",
      os: "macos",
      arch: "aarch64",
      command: "r",
      trace_version: "4",
      build_flags: 0,
      commitish: "605e221",
      addresses: [{ address: 0x1063487, object: "bun" }],
      reason: { kind: "segfault", addr_hi: 0, addr_lo: 0xdeadbeef | 0 },
    },
  ];

  for (const c of cases) {
    test(`${c.os}-${c.arch} v${c.trace_version} ${c.reason.kind}`, async () => {
      const result = await parse(buildTraceString(c));
      expect(result).not.toBeNull();
      const p = result!;

      expect(p.version).toBe(c.version);
      expect(p.os).toBe(c.os);
      expect(p.arch).toBe(c.arch);
      expect(p.command).toBe(c.command);
      expect(p.commitish).toBe(c.commitish);
      expect(p.features).toEqual(c.features ?? [0, 0]);
      expect(p.is_canary).toBe(c.trace_version === "2" || !!((c.build_flags ?? 0) & 1));

      expect(p.addresses).toHaveLength(c.addresses.length);
      for (let i = 0; i < c.addresses.length; i++) {
        expect(p.addresses[i].address).toBe(c.addresses[i].address);
        const obj = c.addresses[i].object;
        expect(p.addresses[i].object).toBe(obj.startsWith("/") ? obj.slice(1) : obj);
      }

      if (c.reason.kind === "panic") expect(p.message).toBe(`panic: ${c.reason.message}`);
      if (c.reason.kind === "unreachable") expect(p.message).toContain("unreachable");
      if (c.reason.kind === "segfault") expect(p.message).toContain((c.reason.addr_lo >>> 0).toString(16).toUpperCase());
      if (c.reason.kind === "abort") {
        expect(p.message).toBe("abort() called");
        expect(p.fault_address).toBeUndefined();
      }
      if (c.reason.kind === "trap") {
        expect(p.message).toContain("Trap instruction at address 0x");
        expect(p.fault_address).toBe("102F864F4");
      }

      if (c.trace_version === "4" && c.debug_id) {
        expect(p.debug_id).toBe(c.debug_id);
      } else {
        expect(p.debug_id).toBeUndefined();
      }
      if (c.trace_version === "4") expect(p.fault_registers).toBeUndefined();

      if (c.registers) {
        expect(p.fault_registers).toBeDefined();
        expect(p.fault_registers!.pc).toEqual(c.registers.pc);
        expect(p.fault_registers!.values).toEqual(c.registers.values);
        const expected_names = c.registers.values.length === 17 ? "rax" : c.registers.values.length === 33 ? "x0" : undefined;
        if (expected_names) expect(p.fault_registers!.names[0]).toBe(expected_names);
      } else if (c.trace_version === "3") {
        expect(p.fault_registers).toBeUndefined();
      }
    });
  }
});

describe("v4 header", () => {
  const base = {
    version: "1.4.0",
    os: "linux",
    arch: "x86_64",
    command: "a",
    trace_version: "4",
    build_flags: 0,
    commitish: "2c2ef7c",
    addresses: [{ address: 0x42, object: "bun" }],
    reason: { kind: "oom" },
  } as const satisfies BuildTraceOpts;
  const id = "00112233445566778899aabbccddeeff";

  /** `base` with a hand-written header in place of the one the helper writes. */
  function withHeader(header: string): string {
    const generated = encodeHeader(base);
    const full = buildTraceString(base);
    const at = full.indexOf(generated, full.indexOf("/") + 1);
    return full.slice(0, at) + header + full.slice(at + generated.length);
  }

  test("fields with tags this decoder does not know are skipped", async () => {
    const p = await parse(
      buildTraceString({
        ...base,
        build_flags: 1,
        debug_id: id,
        extra_header_fields: [
          [7, "anything/goes+here_9"],
          [300, ""],
        ],
      }),
    );
    expect(p).toMatchObject({ is_canary: true, debug_id: id, commitish: base.commitish });
    expect(p!.addresses).toEqual([{ address: 0x42, object: "bun" }]);
    expect(p!.message).toBe("Bun ran out of memory");
  });

  test("field order does not matter", async () => {
    const header = encodeVlq(2) + encodeVlq(1) + encodeVlq(id.length) + id + encodeVlq(0) + encodeVlq(1) + encodeVlq(1);
    expect(await parse(withHeader(header))).toMatchObject({ is_canary: true, debug_id: id });
  });

  test("a header with only build flags means the executable has no id", async () => {
    const p = await parse(buildTraceString({ ...base, build_flags: 1 }));
    expect(p).toMatchObject({ is_canary: true });
    expect(p!.debug_id).toBeUndefined();
  });

  test("a field length running past the end of the string is rejected", async () => {
    expect(await parse(withHeader(encodeVlq(1) + encodeVlq(1) + encodeVlq(5000) + "0011"))).toBeNull();
  });

  test("an absurd field count is rejected", async () => {
    expect(await parse(withHeader(encodeVlq(100000)))).toBeNull();
  });

  test("a malformed debug id field is rejected", async () => {
    for (const bad of ["abc", "AABBCCDD", "", "zz".repeat(8)]) {
      expect(await parse(buildTraceString({ ...base, debug_id: bad }))).toBeNull();
    }
  });

  test("a build flags field that is not exactly one VLQ is rejected", async () => {
    expect(await parse(withHeader(encodeVlq(1) + encodeVlq(0) + encodeVlq(2) + "AA"))).toBeNull();
    expect(await parse(withHeader(encodeVlq(1) + encodeVlq(0) + encodeVlq(0)))).toBeNull();
  });

  test("is_canary comes from the build flags field", async () => {
    expect((await parse(buildTraceString({ ...base, build_flags: 1 })))!.is_canary).toBe(true);
    expect((await parse(buildTraceString({ ...base, build_flags: 0 })))!.is_canary).toBe(false);
  });

  test("traces that differ only in debug id get different remap cache keys", async () => {
    const a = (await parse(buildTraceString({ ...base, debug_id: "00".repeat(16) })))!;
    const b = (await parse(buildTraceString({ ...base, debug_id: "ff".repeat(16) })))!;
    const none = (await parse(buildTraceString(base)))!;
    expect(parseCacheKey(a)).not.toBe(parseCacheKey(b));
    expect(parseCacheKey(a)).not.toBe(parseCacheKey(none));
    // A v1 trace of the same commit and addresses keys exactly as it did
    // before the field existed.
    const v1 = (await parse(buildTraceString({ ...base, trace_version: "1" })))!;
    expect(parseCacheKey(v1)).toBe(parseCacheKey(none));
  });
});
