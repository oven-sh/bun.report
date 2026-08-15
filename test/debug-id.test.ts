import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheName,
  linkVariant,
  publishedLinks,
  readExecutableDebugId,
  selectDebugFile,
  type Link,
} from "../backend/debug-id";

const dir = mkdtempSync(join(tmpdir(), "bun-report-debug-id-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, contents: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
/** Lays `parts` out at the given absolute offsets in a zero-filled buffer. */
function layout(size: number, parts: [offset: number, bytes: Buffer][]): Buffer {
  const out = Buffer.alloc(size);
  for (const [offset, bytes] of parts) bytes.copy(out, offset);
  return out;
}

describe("readExecutableDebugId", () => {
  test("ELF: descriptor of the NT_GNU_BUILD_ID note, skipping other notes", () => {
    const build_id = "caac16c6401beba3fdd7e29cafe9bd212a0a23f8"; // readelf -n of a real bun-debug
    const note = (type: number, desc: Buffer) =>
      Buffer.concat([u32(4), u32(desc.length), u32(type), Buffer.from("GNU\0", "latin1"), desc]);
    const notes = Buffer.concat([
      note(1 /* NT_GNU_ABI_TAG */, Buffer.alloc(16, 0xaa)),
      note(3 /* NT_GNU_BUILD_ID */, Buffer.from(build_id, "hex")),
    ]);
    const notes_offset = 64 + 2 * 56;
    const elf = layout(notes_offset + notes.length, [
      [0, Buffer.from("\x7fELF", "latin1")],
      [0x20, u64(64)], // e_phoff
      [0x36, u16(56)], // e_phentsize
      [0x38, u16(2)], // e_phnum
      // phdr 0: PT_LOAD, must be ignored.
      [64, u32(1)],
      // phdr 1: PT_NOTE at notes_offset.
      [64 + 56, u32(4)],
      [64 + 56 + 8, u64(notes_offset)],
      [64 + 56 + 32, u64(notes.length)],
      [notes_offset, notes],
    ]);
    expect(readExecutableDebugId(file("a.elf", elf))).toBe(build_id);
  });

  test("ELF without a build-id note", () => {
    const elf = layout(64, [
      [0, Buffer.from("\x7fELF", "latin1")],
      [0x20, u64(64)],
      [0x36, u16(56)],
      [0x38, u16(0)],
    ]);
    expect(readExecutableDebugId(file("no-note.elf", elf))).toBeUndefined();
  });

  test("PE: CodeView GUID in the order llvm-readobj and dumpbin print it", () => {
    // llvm-readobj --coff-debug-directory on a real bun-debug.exe printed
    // PDBGUID: {94466803-4EEA-D862-4C4C-44205044422E}; these are the bytes as
    // they sit in the file (the first three fields little-endian).
    const guid_in_file = Buffer.from("03684694" + "ea4e" + "62d8" + "4c4c44205044422e", "hex");
    const code_view = Buffer.concat([
      Buffer.from("RSDS", "latin1"),
      guid_in_file,
      u32(1),
      Buffer.from("bun.pdb\0", "latin1"),
    ]);

    const pe_offset = 64;
    const optional_header_size = 112 + 16 * 8;
    const optional_header = pe_offset + 24;
    const section_table = optional_header + optional_header_size;
    const section_rva = 0x1000;
    const section_file_offset = 512;
    const entry_size = 28;
    const code_view_offset = section_file_offset + 2 * entry_size;

    const pe = layout(code_view_offset + code_view.length, [
      [0, Buffer.from("MZ", "latin1")],
      [0x3c, u32(pe_offset)],
      [pe_offset, Buffer.from("PE\0\0", "latin1")],
      [pe_offset + 4 + 2, u16(1)], // NumberOfSections
      [pe_offset + 4 + 16, u16(optional_header_size)],
      [optional_header, u16(0x20b)],
      [optional_header + 108, u32(16)], // NumberOfRvaAndSizes
      [optional_header + 112 + 6 * 8, u32(section_rva)], // debug directory rva...
      [optional_header + 112 + 6 * 8 + 4, u32(2 * entry_size)], // ...and size
      [section_table + 12, u32(section_rva)], // VirtualAddress
      [section_table + 16, u32(0x200)], // SizeOfRawData
      [section_table + 20, u32(section_file_offset)], // PointerToRawData
      // entry 0: IMAGE_DEBUG_TYPE_COFF, must be skipped.
      [section_file_offset + 12, u32(1)],
      // entry 1: CodeView.
      [section_file_offset + entry_size + 12, u32(2)],
      [section_file_offset + entry_size + 24, u32(code_view_offset)],
      [code_view_offset, code_view],
    ]);
    expect(readExecutableDebugId(file("a.exe", pe))).toBe("944668034eead8624c4c44205044422e");
  });

  test("PE without a debug directory", () => {
    const pe = layout(64 + 24 + 240, [
      [0, Buffer.from("MZ", "latin1")],
      [0x3c, u32(64)],
      [64, Buffer.from("PE\0\0", "latin1")],
      [64 + 4 + 16, u16(240)],
      [88, u16(0x20b)],
      [88 + 108, u32(16)],
    ]);
    expect(readExecutableDebugId(file("no-debug.exe", pe))).toBeUndefined();
  });

  test("Mach-O: LC_UUID bytes in order, after other load commands", () => {
    const uuid = "0123456789abcdef0123456789abcdef";
    const segment = layout(72, [
      [0, u32(0x19 /* LC_SEGMENT_64 */)],
      [4, u32(72)],
    ]);
    const uuid_command = Buffer.concat([u32(0x1b), u32(24), Buffer.from(uuid, "hex")]);
    const commands = Buffer.concat([segment, uuid_command]);
    const macho = layout(32 + commands.length, [
      [0, u32(0xfeedfacf)],
      [16, u32(2)], // ncmds
      [20, u32(commands.length)], // sizeofcmds
      [32, commands],
    ]);
    expect(readExecutableDebugId(file("a.macho", macho))).toBe(uuid);
  });

  test("not an executable, or not there at all", () => {
    expect(
      readExecutableDebugId(file("features.json", Buffer.from('{"features":[]}'))),
    ).toBeUndefined();
    expect(readExecutableDebugId(file("tiny", Buffer.from("MZ")))).toBeUndefined();
    expect(readExecutableDebugId(join(dir, "does-not-exist"))).toBeUndefined();
  });

  test("the binary running this test has an id of a plausible shape", () => {
    // bun's own releases are linked with a build-id / PDB / LC_UUID, so this
    // exercises the real-file path on whichever platform the tests run.
    expect(readExecutableDebugId(process.execPath)).toMatch(/^[0-9a-f]{32}([0-9a-f]{8})?$/);
  });
});

describe("publishedLinks", () => {
  test("the builds that share a platform char, plain one first", () => {
    expect(publishedLinks("linux", "x86_64")).toEqual([
      "x64",
      "x64-musl",
      "x64-android",
      "x64-baseline",
    ]);
    expect(publishedLinks("linux", "aarch64")).toEqual([
      "aarch64",
      "aarch64-musl",
      "aarch64-android",
    ]);
    expect(publishedLinks("windows", "x86_64")).toEqual(["x64", "x64-baseline"]);
    expect(publishedLinks("macos", "x86_64")).toEqual(["x64", "x64-baseline"]);
    expect(publishedLinks("macos", "aarch64")).toEqual(["aarch64"]);
    expect(publishedLinks("windows", "aarch64")).toEqual(["aarch64"]);
    expect(publishedLinks("freebsd", "x86_64")).toEqual(["x64"]);
    // The old baseline platform chars: their own build first, as before.
    expect(publishedLinks("linux", "x86_64_baseline")).toEqual([
      "x64-baseline",
      "x64-musl",
      "x64-android",
      "x64",
    ]);
    expect(publishedLinks("windows", "x86_64_baseline")).toEqual(["x64-baseline", "x64"]);
  });

  test("linkVariant", () => {
    expect(linkVariant("x64")).toBeUndefined();
    expect(linkVariant("aarch64")).toBeUndefined();
    expect(linkVariant("x64-musl")).toBe("musl");
    expect(linkVariant("aarch64-android")).toBe("android");
    expect(linkVariant("x64-baseline")).toBe("baseline");
  });
});

describe("selectDebugFile", () => {
  interface Info {
    link: Link;
    debug_id: string | undefined;
  }
  const GLIBC = "aa".repeat(20);
  const MUSL = "bb".repeat(20);
  const ANDROID = "cc".repeat(20);
  const OTHER = "dd".repeat(20);

  function unavailable(link: Link): Error & { code: string } {
    return Object.assign(new Error(`no artifact for ${link}`), { code: "DebugInfoUnavailable" });
  }

  /** `published` maps each link the commit has to the id its executable carries (undefined = unreadable). */
  function bucket(published: Record<Link, string | undefined | Error>) {
    const fetched: Link[] = [];
    const fetch = async (link: Link): Promise<Info> => {
      fetched.push(link);
      if (!(link in published)) throw unavailable(link);
      const entry = published[link];
      if (entry instanceof Error) throw entry;
      return { link, debug_id: entry };
    };
    return { fetch, fetched };
  }
  const upstream_linux = {
    x64: GLIBC,
    "x64-musl": MUSL,
    "x64-android": ANDROID,
    "x64-baseline": GLIBC,
  };

  test("a trace without an id uses the plain build unchecked, as before", async () => {
    const { fetch, fetched } = bucket(upstream_linux);
    expect(await selectDebugFile("linux", "x86_64", undefined, fetch)).toEqual({
      link: "x64",
      debug_id: GLIBC,
    });
    expect(fetched).toEqual(["x64"]);
  });

  test("a trace without an id still fails when the plain build is missing", async () => {
    const { fetch } = bucket({ "x64-musl": MUSL });
    await expect(selectDebugFile("linux", "x86_64", undefined, fetch)).rejects.toMatchObject({
      code: "DebugInfoUnavailable",
    });
  });

  test("an old baseline platform char without an id uses the baseline build, as before", async () => {
    const { fetch, fetched } = bucket(upstream_linux);
    expect(await selectDebugFile("linux", "x86_64_baseline", undefined, fetch)).toEqual({
      link: "x64-baseline",
      debug_id: GLIBC,
    });
    expect(fetched).toEqual(["x64-baseline"]);
  });

  test("the plain build carries the id", async () => {
    const { fetch, fetched } = bucket(upstream_linux);
    expect(await selectDebugFile("linux", "x86_64", GLIBC, fetch)).toEqual({
      link: "x64",
      debug_id: GLIBC,
      debug_file: "match",
    });
    expect(fetched).toEqual(["x64"]);
  });

  test("a musl trace (reports 'l' like glibc) is matched to the musl build", async () => {
    const { fetch, fetched } = bucket(upstream_linux);
    expect(await selectDebugFile("linux", "x86_64", MUSL, fetch)).toEqual({
      link: "x64-musl",
      debug_id: MUSL,
      debug_file: "match",
    });
    expect(fetched).toEqual(["x64", "x64-musl"]);
  });

  test("an android trace is matched to the android build", async () => {
    const { fetch, fetched } = bucket({
      aarch64: GLIBC,
      "aarch64-musl": MUSL,
      "aarch64-android": ANDROID,
    });
    expect(await selectDebugFile("linux", "aarch64", ANDROID, fetch)).toMatchObject({
      link: "aarch64-android",
      debug_file: "match",
    });
    expect(fetched).toEqual(["aarch64", "aarch64-musl", "aarch64-android"]);
  });

  test("a trace from a tree that builds a separate baseline binary (the bun-windows-x64 vs -baseline case)", async () => {
    const baseline = "ee".repeat(16);
    const { fetch, fetched } = bucket({ x64: "ff".repeat(16), "x64-baseline": baseline });
    expect(await selectDebugFile("windows", "x86_64", baseline, fetch)).toEqual({
      link: "x64-baseline",
      debug_id: baseline,
      debug_file: "match",
    });
    expect(fetched).toEqual(["x64", "x64-baseline"]);
  });

  test("no published build carries the id: the plain build, flagged mismatch, after trying them all", async () => {
    const { fetch, fetched } = bucket(upstream_linux);
    expect(await selectDebugFile("linux", "x86_64", OTHER, fetch)).toEqual({
      link: "x64",
      debug_id: GLIBC,
      debug_file: "mismatch",
    });
    expect(fetched).toEqual(["x64", "x64-musl", "x64-android", "x64-baseline"]);
  });

  test("builds the commit was not published as are skipped, not errors", async () => {
    const { fetch } = bucket({ x64: GLIBC });
    expect(await selectDebugFile("linux", "x86_64", OTHER, fetch)).toMatchObject({
      link: "x64",
      debug_file: "mismatch",
    });
  });

  test("an arch with a single build goes straight to mismatch", async () => {
    const { fetch, fetched } = bucket({ aarch64: GLIBC });
    expect(await selectDebugFile("macos", "aarch64", OTHER, fetch)).toMatchObject({
      link: "aarch64",
      debug_file: "mismatch",
    });
    expect(fetched).toEqual(["aarch64"]);
  });

  test("a plain build whose executable has no readable id is used unverified", async () => {
    const { fetch, fetched } = bucket({ x64: undefined, "x64-musl": MUSL });
    expect(await selectDebugFile("linux", "x86_64", MUSL, fetch)).toEqual({
      link: "x64",
      debug_id: undefined,
      debug_file: "unverified",
    });
    expect(fetched).toEqual(["x64"]);
  });

  test("the plain build was never published but another build carrying the id was", async () => {
    const { fetch } = bucket({ "x64-musl": MUSL });
    expect(await selectDebugFile("linux", "x86_64", MUSL, fetch)).toMatchObject({
      link: "x64-musl",
      debug_file: "match",
    });
  });

  test("nothing published at all reports the plain build as unavailable", async () => {
    const { fetch } = bucket({});
    await expect(selectDebugFile("linux", "x86_64", MUSL, fetch)).rejects.toMatchObject({
      code: "DebugInfoUnavailable",
      message: "no artifact for x64",
    });
  });

  test("errors other than a missing artifact propagate", async () => {
    const boom = new Error("unzip exploded");
    await expect(
      selectDebugFile("linux", "x86_64", MUSL, bucket({ x64: boom }).fetch),
    ).rejects.toBe(boom);
    await expect(
      selectDebugFile("linux", "x86_64", MUSL, bucket({ x64: GLIBC, "x64-musl": boom }).fetch),
    ).rejects.toBe(boom);
  });
});

describe("cacheName", () => {
  test("the plain build keeps the name the cache always used; other builds get their own", () => {
    expect(cacheName("linux", "x86_64", "x64")).toBe("x86_64");
    expect(cacheName("linux", "aarch64", "aarch64")).toBe("aarch64");
    expect(cacheName("linux", "x86_64_baseline", "x64-baseline")).toBe("x86_64_baseline");
    expect(cacheName("linux", "x86_64", "x64-musl")).toBe("x86_64-x64-musl");
    expect(cacheName("windows", "x86_64", "x64-baseline")).toBe("x86_64-x64-baseline");
    // The two directions of the baseline pair must not share an entry.
    expect(cacheName("linux", "x86_64_baseline", "x64")).toBe("x86_64_baseline-x64");
    expect(
      new Set(publishedLinks("linux", "x86_64").map((l) => cacheName("linux", "x86_64", l))).size,
    ).toBe(4);
  });
});
