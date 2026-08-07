import { describe, test, expect } from "bun:test";
import {
  buildFingerprint,
  foreignCrashInfo,
  isStdlibPath,
  normalizeModuleName,
  toStackFrame,
} from "../backend/sentry";
import type { Address, Parse, Remap } from "../lib";

describe("isStdlibPath", () => {
  test.each([
    // Rust std/core/alloc (bun 1.4.x)
    ["src/rust/library/alloc/src/boxed.rs", true],
    ["src/rust/library/std/src/panicking.rs", true],
    ["src/rust/library/core/src/result.rs", true],
    // Zig stdlib (bun 1.3.x and earlier)
    ["src/deps/zig/lib/std/debug.zig", true],
    // Real bun frames
    ["src/sys/Error.rs", false],
    ["src/runtime/node/node_fs.rs", false],
    ["src/jsc/bindings/bindings.cpp", false],
    ["src/bun.js/node/node_fs.zig", false],
    ["vendor/WebKit/Source/JavaScriptCore/runtime/CallData.cpp", false],
  ])("%s -> %p", (path, expected) => {
    expect(isStdlibPath(path)).toBe(expected);
  });
});

function unknown(object: string, address: number): Address {
  return { remapped: false, object, address };
}

function remapped(fn: string, object = "bun", address = 0x1000): Address {
  return { remapped: true, src: null, function: fn, object, address };
}

function makeParse(message: string): Parse {
  return {
    message,
    os: "windows",
    arch: "x86_64",
    version: "1.4.0",
    commitish: "abcdef123",
  } as Parse;
}

function makeRemap(message: string, addresses: Address[]): Remap {
  return {
    version: "1.4.0",
    message,
    os: "windows",
    arch: "x86_64",
    commit: { oid: "abcdef1234567890", pr: null },
    addresses,
    command: "StandaloneExecutable",
    features: [],
  } as Remap;
}

// Real crash shapes from Sentry (addresses are innermost-first, as parsed
// from the trace string).

// BUN-2PMH: Trend Micro hooks fault inside ntdll on their own thread.
const TREND_MICRO: Address[] = [
  unknown("ntdll.dll", 0x4415a),
  unknown("ntdll.dll", 0x43739),
  unknown("ntdll.dll", 0x45769),
  unknown("KERNEL32.DLL", 0x28d78),
  unknown("TmUmEvt64.dll", 0x3b3a6),
  unknown("TmUmEvt64.dll", 0x745b8),
  unknown("tmmon64.dll", 0x6da4b),
];

// BUN-2PYE: Tencent tc_ad.dll thread faults in its own code.
const TC_AD: Address[] = [
  unknown("tc_ad.dll", 0x49ad8),
  unknown("tc_ad.dll", 0x49d94),
  unknown("ntdll.dll", 0x15f89e),
];

// BUN-2PFR: embedded native addon extracted to a hashed temp name.
const EMBEDDED_ADDON: Address[] = [unknown(".dafb37e78ed77f3f-0.node", 0xfe455)];

describe("normalizeModuleName", () => {
  test.each([
    // legacy hash-only temp names (bun <= 1.4.0)
    [".dafb37e78ed77f3f-0.node", "embedded .node"],
    [".ab12cd34-1F.node", "embedded .node"],
    [".dafb37e78ed77f3f-0.dll", "embedded .dll"],
    // stem-carrying temp names (newer builds); the stem itself ends with the
    // bundler's 8-char base32 asset hash, which must not affect identity
    [".my_native_addon-msn58fw9.c7a034da05c78833-0.node", "my_native_addon.node"],
    [".better_sqlite3.dafb37e78ed77f3f-0.node", "better_sqlite3.node"],
    [".my-lib.1a2b3c4d5e6f7a8b-2.so", "my-lib.so"],
    // everything else passes through
    ["tmmon64.dll", "tmmon64.dll"],
    ["libsystem_kernel.dylib", "libsystem_kernel.dylib"],
    ["node.napi.node", "node.napi.node"],
  ])("%s -> %s", (object, expected) => {
    expect(normalizeModuleName(object)).toBe(expected);
  });
});

describe("foreignCrashInfo", () => {
  test("blames the hook DLL, not the system DLL it called into", () => {
    expect(foreignCrashInfo(TREND_MICRO)).toEqual({
      culprit: "TmUmEvt64.dll",
      innermost: "ntdll.dll",
    });
  });

  test("culprit is the fault-site module when it is not a system DLL", () => {
    expect(foreignCrashInfo(TC_AD)).toEqual({
      culprit: "tc_ad.dll",
      innermost: "tc_ad.dll",
    });
  });

  test("normalizes embedded addon temp names", () => {
    expect(foreignCrashInfo(EMBEDDED_ADDON)).toEqual({
      culprit: "embedded .node",
      innermost: "embedded .node",
    });
  });

  test("all-system stack falls back to the innermost module", () => {
    const addrs = [unknown("ntdll.dll", 0x100), unknown("KERNELBASE.dll", 0x200)];
    expect(foreignCrashInfo(addrs)).toEqual({
      culprit: "ntdll.dll",
      innermost: "ntdll.dll",
    });
  });

  test("null when any frame is in bun's image", () => {
    expect(foreignCrashInfo([unknown("ntdll.dll", 0x100), unknown("bun", 0x166cbcc)])).toBeNull();
    expect(foreignCrashInfo([remapped("uv_fs_rename"), unknown("ntdll.dll", 0x100)])).toBeNull();
  });

  test("null for JIT/unknown-only stacks", () => {
    expect(foreignCrashInfo([unknown("?", 0x7f00dead), unknown("js", 0)])).toBeNull();
  });
});

describe("buildFingerprint", () => {
  const msg = "Segmentation fault at address 0x00000030";

  test("foreign-only stacks group by crash type + modules, ignoring offsets", () => {
    const a = buildFingerprint(makeParse(msg), makeRemap(msg, TREND_MICRO));
    expect(a).toEqual(["Segfault", "foreign-module", "tmumevt64.dll", "ntdll.dll"]);

    // Same modules, different offsets (other Trend Micro version) — same group.
    const other = TREND_MICRO.map(x => ({ ...x, address: (x as any).address + 0x1234 }));
    expect(buildFingerprint(makeParse(msg), makeRemap(msg, other))).toEqual(a);
  });

  test("embedded addons with per-run temp names share one group", () => {
    const a = buildFingerprint(makeParse(msg), makeRemap(msg, EMBEDDED_ADDON));
    const b = buildFingerprint(
      makeParse(msg),
      makeRemap(msg, [unknown(".00ff00ff00ff00ff-7.node", 0x1234)]),
    );
    expect(a).toEqual(b);
    expect(a).toEqual(["Segfault", "foreign-module", "embedded .node", "embedded .node"]);
  });

  test("unsymbolicated bun frames keep Sentry's default grouping", () => {
    const addrs = [unknown("bun", 0x123456), unknown("ntdll.dll", 0x100)];
    expect(buildFingerprint(makeParse(msg), makeRemap(msg, addrs))).toEqual(["{{ default }}"]);
  });

  test("symbolicated stacks are unaffected", () => {
    const addrs = [remapped("uv_fs_rename"), remapped("uv__fs_work"), unknown("ntdll.dll", 0x100)];
    expect(buildFingerprint(makeParse(msg), makeRemap(msg, addrs))).toEqual([
      "Segfault",
      "uv_fs_rename",
      "uv__fs_work",
    ]);
  });
});

describe("toStackFrame foreign naming", () => {
  const commit = "abcdef1234567890";

  test("unsymbolicated foreign frames get module+offset names", async () => {
    const frame = await toStackFrame(unknown("tmmon64.dll", 0x6da4b), commit);
    expect(frame).toEqual({
      package: "tmmon64.dll",
      function: "tmmon64.dll+0x6da4b",
      in_app: false,
      instruction_addr: "0x6da4b",
    });
  });

  test("embedded addon temp names are normalized in the frame name", async () => {
    const frame = await toStackFrame(unknown(".dafb37e78ed77f3f-0.node", 0xfe455), commit);
    expect(frame.function).toBe("embedded .node+0xfe455");
    // package keeps the raw name for forensics
    expect(frame.package).toBe(".dafb37e78ed77f3f-0.node");
  });

  test("bun/js/unknown objects stay <anonymous>", async () => {
    expect((await toStackFrame(unknown("bun", 0x123), commit)).function).toBe("<anonymous>");
    expect((await toStackFrame(unknown("?", 0x123), commit)).function).toBe("<anonymous>");
    expect((await toStackFrame(unknown("js", 0), commit)).function).toBe("<anonymous>");
  });
});
