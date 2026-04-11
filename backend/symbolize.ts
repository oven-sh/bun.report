import type { Address, ParsedAddress } from "../lib/parser";
import type { Platform } from "../lib/util";

const macho_first_offset = 0x100000000;

/**
 * Given the raw addresses from a parsed trace, return the hex strings that
 * should be passed to the symbolizer for `object === "bun"` frames.
 */
export function adjustBunAddresses(addresses: ParsedAddress[], os: Platform): string[] {
  // crash_handler.zig already encodes `addr - 1` on macOS/Linux but emits raw
  // return addresses on Windows. Decrement here for Windows only (all bun
  // frames after the first — the first is ExceptionAddress, the exact fault
  // PC). Doing it server-side retroactively fixes existing traces and avoids
  // a wire-format version bump.
  let first_bun_seen = false;
  const out: string[] = [];
  for (const a of addresses) {
    if (a.object !== "bun") continue;
    let addr = a.address;
    if (os === "windows" && first_bun_seen) addr -= 1;
    first_bun_seen = true;
    if (os === "macos") addr += macho_first_offset;
    out.push("0x" + addr.toString(16));
  }
  return out;
}

/**
 * Pure post-symbolizer pipeline: takes the original parsed addresses plus the
 * raw stdout from llvm-symbolizer / pdb-addr2line and produces the final
 * filtered Address[] exactly as remapUncached does.
 *
 * Extracted so fixture tests can replay recorded stdout without spawning a
 * process or fetching debug files.
 */
export function processSymbolizerOutput(addresses: ParsedAddress[], stdout: string): Address[] {
  // llvm-symbolizer outputs one block per input address, blocks separated by a
  // blank line. With --inlines a block holds N (function, source) line-pairs,
  // innermost first; --no-inlines and pdb-addr2line emit exactly one pair.
  const blocks = stdout
    .replace(/\n+$/, "")
    .split(/\n\n+/)
    .map(b => b.split("\n"));
  let blockIdx = 0;

  let mapped_addrs: Address[] = [];
  for (const addr of addresses) {
    if (addr.object !== "bun") {
      mapped_addrs.push({ remapped: false, object: addr.object, address: addr.address });
      continue;
    }
    const block = blocks[blockIdx++] ?? [];
    let pushed = 0;
    for (let i = 0; i + 1 < block.length; i += 2) {
      const src = parsePdb2AddrLineFile(block[i + 1]);
      mapped_addrs.push({
        remapped: true,
        src: src ? { file: src.file, line: src.line } : null,
        function: cleanFunctionName(block[i]),
        object: "bun",
      });
      pushed++;
    }
    if (pushed === 0) {
      mapped_addrs.push({ remapped: false, object: addr.object, address: addr.address });
    }
  }

  if (mapped_addrs[0]?.function?.includes("WTF::jscSignalHandler")) {
    const old = mapped_addrs.slice();

    mapped_addrs.shift();

    while (mapped_addrs.length > 0 && (!mapped_addrs[0].remapped || mapped_addrs[0].function === "??")) {
      mapped_addrs.shift();
    }

    if (mapped_addrs.length === 0) {
      mapped_addrs = old;
    }
  }

  return filterAddresses(mapped_addrs);
}

export function filterAddresses(addrs: Address[]): Address[] {
  const old = addrs.slice();

  while (
    addrs[0]?.function?.includes?.("WTF::jscSignalHandler") ||
    addrs[0]?.function?.includes?.("assertionFailure") ||
    addrs[0]?.function?.includes?.("panic") ||
    addrs[0]?.function?.endsWith?.("assert")
  ) {
    addrs.shift();

    // remove additional `??` lines
    while (addrs.length > 0 && (!addrs[0].remapped || addrs[0].function === "??")) {
      addrs.shift();
    }
  }

  // remove trailing ?? lines
  while (addrs.length > 0 && (!addrs[addrs.length - 1].remapped || addrs[addrs.length - 1].function === "??")) {
    addrs.pop();
  }

  // if this operation somehow removes all addresses, revert
  if (addrs.length === 0) {
    return old;
  }

  return addrs;
}

function withoutZigAnon(str: string): string {
  if (str && !str.startsWith("__anon_")) {
    // Remove all __anon_${number} patterns
    str = str.replace(/__anon_\d+/g, "");
  }

  if (str && !str.startsWith("__struct_")) {
    // Remove all __struct_${number} patterns
    str = str.replace(/__struct_\d+/g, "");
  }

  return str;
}

export function cleanFunctionName(str: string): string {
  const last_paren = str.lastIndexOf(")");
  if (last_paren === -1) {
    return withoutZigAnon(str);
  }
  let last_open_paren = last_paren;
  let n = 1;
  while (last_open_paren > 0) {
    last_open_paren--;
    if (str[last_open_paren] === ")") {
      n++;
    } else if (str[last_open_paren] === "(") {
      n--;
      if (n === 0) {
        break;
      }
    }
  }
  const before = str.slice(0, last_open_paren).replace(/\(.+?\)/g, "(...)");
  const after = str.slice(last_paren + 1);
  // C++ args are the trailing group: `Foo::bar(int, char)` -> drop entirely.
  // Zig generic type params sit before the method: `Queue(Job,.next).push` ->
  // collapse to `Queue(...).push` so the method name survives.
  return withoutZigAnon(after ? before + "(...)" + after : before);
}

export function parsePdb2AddrLineFile(str: string): { file: string; line: number } | null {
  if (str.startsWith("??:")) return null;

  const last_colon = str.lastIndexOf(":");
  if (last_colon === -1) {
    return null;
  }

  const second_colon = str.lastIndexOf(":", last_colon - 1);
  if (second_colon === -1) {
    return null;
  }

  const line = Math.floor(Number(str.slice(second_colon + 1, last_colon)));
  if (isNaN(line)) {
    return null;
  }

  const file_full = str.slice(0, second_colon).replace(/\\/g, "/");
  // Strip the CI build root, keeping the first repo-level dir (src, vendor,
  // packages) onward. The old `.*?/src/` regex ate `vendor/libuv/` off paths
  // like `.../vendor/libuv/src/win/process.c`.
  const m = file_full.match(/(?:^|\/)(src|vendor|packages)\/(.*)$/);
  const file = m ? `${m[1]}/${m[2]}` : file_full;

  return { file, line };
}
