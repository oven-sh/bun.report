import type { Address, ParsedAddress } from "../lib/parser";
import type { Platform } from "../lib/util";

const macho_first_offset = 0x100000000;

/**
 * Given the raw addresses from a parsed trace, return the hex strings that
 * should be passed to the symbolizer for `object === "bun"` frames.
 */
export function adjustBunAddresses(addresses: ParsedAddress[], os: Platform): string[] {
  return addresses
    .filter(a => a.object === "bun")
    .map(a => "0x" + (os === "macos" ? macho_first_offset + a.address : a.address).toString(16));
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
  const lines = stdout.split("\n").filter(l => l.length > 0);

  let mapped_addrs: Address[] = addresses.map(addr => {
    if (addr.object === "bun") {
      const fn_line = lines.shift();
      const source_line = lines.shift();
      if (fn_line && source_line) {
        const parsed_line = parsePdb2AddrLineFile(source_line);

        return {
          remapped: true,
          src: parsed_line
            ? {
                file: parsed_line.file,
                line: parsed_line.line,
              }
            : null,
          function: cleanFunctionName(fn_line),
          object: "bun",
        } satisfies Address;
      }
    }

    return {
      remapped: false,
      object: addr.object,
      address: addr.address,
    } satisfies Address;
  });

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
  return withoutZigAnon(str.slice(0, last_open_paren).replace(/\(.+?\)/g, "(...)"));
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
