import { type Platform, type Arch } from "./util";
import { decodePart } from "./vlq";

declare const DEBUG: boolean;
if (typeof DEBUG === "undefined") {
  (globalThis as any).DEBUG = process.env.NODE_ENV !== "production";
}

const debug = process.env.NODE_ENV === "production" ? () => { } : console.log;

const platform_map: { [key: string]: [Platform, Arch] } = {
  w: ["windows", "x86_64"],
  e: ["windows", "x86_64_baseline"],
  // 'W': ['windows', 'aarch64'],

  m: ["macos", "x86_64"],
  b: ["macos", "x86_64_baseline"],
  M: ["macos", "aarch64"],

  l: ["linux", "x86_64"],
  B: ["linux", "x86_64_baseline"],
  L: ["linux", "aarch64"],
};

const reasons: { [key: string]: (input: string) => string | Promise<string> } =
{
  "0": parsePanicMessage,
  "1": () => "panic: reached unreachable code",
  "2": (addr) => `Segmentation fault at ${parseVlqAddr(addr)}`,
  "3": (addr) => `Illegal instruction at ${parseVlqAddr(addr)}`,
  "4": (addr) => `Bus error at ${parseVlqAddr(addr)}`,
  "5": (addr) => `Floating point exception at ${parseVlqAddr(addr)}`,
  "6": () => `Unaligned memory access`,
  "7": () => `Stack overflow`,
  "8": (rest) => "error: " + rest,
  "9": () => `Bun ran out of memory`,
};

export interface Parse {
  /**
   * This version is the *specified* version, not the actual version this remaps
   * to. It should not be trusted as factual.
   */
  version: string;
  message: string;
  os: Platform;
  arch: Arch;
  commitish: string;
  addresses: ParsedAddress[];
  command: string;
  features: [number, number];
  /**
   * Always false before v1.1.10. Afterwards, this reflects if this was a canary
   * build or not. Due to the setup of Bun's CI, a single commit can have both a
   * canary build *and* a release build, so inferring that off of the commit is
   * not enough.
   */
  is_canary?: boolean;
  /** lazily computed by parseCacheKey */
  cache_key?: string;
}

export interface ResolvedCommit {
  oid: string;
  pr: {
    title: string;
    number: number;
    ref: string;
  } | null;
}

export interface Remap {
  message: string;
  version: string;
  os: Platform;
  arch: Arch;
  commit: ResolvedCommit;
  addresses: Address[];
  issue?: number;
  command: string;
  features: string[];
}

export type Address = RemappedAddress | UnknownAddress;

export interface ParsedAddress {
  address: number;
  object: "bun" | "js" | string;
}

export interface RemappedAddress {
  remapped: true;
  src: { file: string; line: number } | null;
  function: string;
  object: string;
}

export interface UnknownAddress {
  remapped: false;
  object: string;
  function?: string;
  address: number;
}

export interface RemapAPIResponse {
  commit: ResolvedCommit;
  addresses: Address[];
  issue: number | null;
  command: string;
  version: string;
  features: string[];
}

function validateSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

export async function parse(str: string): Promise<Parse | null> {
  try {
    str = str
      .replace(/^(?:(https?:\/\/)?bun\.report\/)?/, "")
      .replace(/\/view$/, "");

    const first_slash = str.indexOf("/");
    const version = str.slice(0, first_slash);
    if (!validateSemver(version)) return null;

    const [os, arch] = platform_map[str[first_slash + 1]] ?? [];
    if (!os || !arch) {
      DEBUG && debug("invalid platform '%s'", str[first_slash + 1]);
      return null;
    }

    const command = str[first_slash + 2];
    const trace_version = str[first_slash + 3];

    let is_canary = false;
    if (trace_version === "1") {
      // '1' - original. uses 7 char hash with VLQ encoded stack-frames
    } else if (trace_version === "2") {
      // '2' - same as '1' but this build is known to be a canary build
      is_canary = true;
    } else {
      DEBUG && debug("invalid version '%s'", trace_version);
      return null;
    }

    const addresses: ParsedAddress[] = [];

    let i = first_slash + 4 + 7;

    const commitish = str.slice(first_slash + 4, i);

    let c, object, address, inc;

    [c, inc] = decodePart(str.slice(i));
    i += inc;
    [object, inc] = decodePart(str.slice(i));
    i += inc;
    if (object == null || c == null) {
      DEBUG && debug("invalid features part %o", str.slice(i));
      return null;
    }
    const features_data = [c, object] as [number, number];

    while (true) {
      c = str[i];
      object = "bun";
      if (c === undefined) {
        DEBUG && debug("invalid end of string at %o", i);
        return null;
      }

      if (c === "=") {
        addresses.push({ address: 0, object: "js" });
        i += 1;
        continue;
      }

      if (c === "_") {
        addresses.push({ address: 0, object: "?" });
        i += 1;
        continue;
      }

      [address, inc] = decodePart(str.slice(i));
      if (address == null) {
        DEBUG && debug("invalid first part %o", str.slice(i));
        return null;
      }
      i += inc;

      if (address === 0) {
        break;
      }

      if (address === 1) {
        [c, inc] = decodePart(str.slice(i));
        if (c == null) {
          DEBUG && debug("invalid object len %o", str.slice(i));
          return null;
        }
        i += inc;

        object = str.slice(i, i + c).replace(/^\//, "");
        i += c;

        [address, inc] = decodePart(str.slice(i));
        if (address == null) {
          DEBUG && debug("invalid second part %s %o", object, i, str.slice(i));
          return null;
        }
        i += inc;
      }

      addresses.push({ address, object });
    }

    const reason = reasons[str[i]];
    if (!reason) {
      DEBUG && debug("invalid reason %o", str.slice(i));
      return null;
    }
    const message = await reason(str.slice(i + 1));
    if (!message) {
      DEBUG && debug("invalid message %o", str.slice(i));
      return null;
    }
    return {
      version,
      os,
      arch,
      commitish,
      addresses,
      message,
      command,
      features: features_data,
      is_canary,
    };
  } catch (e) {
    DEBUG && debug(e);
    return null;
  }
}

function parsePanicMessage(
  message_compressed: string,
): Promise<string> | string {
  if (typeof Bun !== "undefined") {
    return (
      "panic: " +
      new TextDecoder().decode(
        Bun.gunzipSync(Buffer.from(message_compressed, "base64url")),
      )
    );
  } else {
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    const write_promise = writer.write(
      Uint8Array.from(atob(message_compressed), (c) => c.charCodeAt(0)),
    );
    writer.close();
    const reader = stream.readable.getReader();

    return Promise.all([
      write_promise,
      (async () => {
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();

          if (done) break;
          chunks.push(value);
        }
        return "panic: " + (await new Blob(chunks).text());
      })(),
    ]).then(
      (x) => x[1],
      () => "",
    );
  }
}

function parseVlqAddr(unparsed_addr: string): string {
  let [first, i] = decodePart(unparsed_addr) as [any, number];
  let [second] = decodePart(unparsed_addr.slice(i));
  if (first == null || second == null) return "unknown address";
  first = first ? correctIntToUint32(first).toString(16) : "";
  return (
    "address 0x" +
    (
      first + correctIntToUint32(second).toString(16).padStart(8, "0")
    ).toUpperCase()
  );
}

function correctIntToUint32(int: number): number {
  return int + (int < 0 ? 2 ** 32 : 0);
}
