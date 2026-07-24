import { type Platform, type Arch } from "./util";
import { decodePart } from "./vlq";

declare const DEBUG: boolean;
if (typeof DEBUG === "undefined") {
  (globalThis as any).DEBUG = process.env.NODE_ENV !== "production";
}

const debug = process.env.NODE_ENV === "production" ? () => {} : console.log;

const platform_map: { [key: string]: [Platform, Arch] } = {
  w: ["windows", "x86_64"],
  e: ["windows", "x86_64_baseline"],
  W: ["windows", "aarch64"],

  m: ["macos", "x86_64"],
  b: ["macos", "x86_64_baseline"],
  M: ["macos", "aarch64"],

  l: ["linux", "x86_64"],
  B: ["linux", "x86_64_baseline"],
  L: ["linux", "aarch64"],
};

const reasons: {
  [key: string]: (fault_address: string | undefined, rest: string) => string | Promise<string>;
} = {
  "0": (_, rest) => parsePanicMessage(rest),
  "1": () => "panic: reached unreachable code",
  "2": addr => `Segmentation fault at address 0x${addr}`,
  "3": addr => `Illegal instruction at address 0x${addr}`,
  "4": addr => `Bus error at address 0x${addr}`,
  "5": addr => `Floating point exception at address 0x${addr}`,
  "6": () => `Unaligned memory access`,
  "7": () => `Stack overflow`,
  "8": (_, rest) => "error: " + rest,
  "9": () => `Bun ran out of memory`,
  a: () => `abort() called`,
  b: addr => `Trap instruction at address 0x${addr}`,
};

// Must mirror `FaultRegisters::NAMES` in bun's src/crash_handler/lib.rs.
// prettier-ignore
const fault_register_names: { [count: number]: readonly string[] } = {
  17: [
    "rax", "rbx", "rcx", "rdx", "rdi", "rsi", "rbp", "rsp",
    "r8",  "r9",  "r10", "r11", "r12", "r13", "r14", "r15", "rip",
  ],
  33: [
    "x0",  "x1",  "x2",  "x3",  "x4",  "x5",  "x6",  "x7",
    "x8",  "x9",  "x10", "x11", "x12", "x13", "x14", "x15",
    "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23",
    "x24", "x25", "x26", "x27", "x28", "fp",  "lr",  "sp", "pc",
  ],
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
  /**
   * Hex string of the faulting address for Segfault/IllegalInstruction/BusError/FPE
   * (reasons "2"–"5"). Absent for panics, OOM, etc. No "0x" prefix.
   */
  fault_address?: string;
  /** lazily computed by parseCacheKey */
  cache_key?: string;
  /**
   * v3+, hardware-fault reasons ("2"–"7") only: GP register snapshot lifted
   * from ucontext_t/CONTEXT at the fault. Present with `values: []` when the
   * encoder had no arch layout (FreeBSD/unknown).
   */
  fault_registers?: FaultRegisters;
}

export interface FaultRegisters {
  /**
   * Image-relative fault pc as a ParsedAddress (ASLR removed, directly
   * remappable). null when the encoder couldn't resolve its own module.
   */
  pc: ParsedAddress | null;
  /** Raw 64-bit register values, indexed parallel to `names`. */
  values: bigint[];
  /**
   * Register names matching `values` indices (from bun's
   * `FaultRegisters::NAMES`). x86_64 ⇒ 17, aarch64 ⇒ 33; empty for other
   * counts (forward compat).
   */
  names: readonly string[];
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
  /**
   * Raw image-relative address this frame was symbolicated from. Multiple
   * inline-expanded frames share the same value. Forwarded to Sentry as
   * `instruction_addr` so the original address survives symbolication.
   */
  address?: number;
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
    str = str.replace(/^(?:(https?:\/\/)?bun\.report\/)?/, "").replace(/\/view$/, "");

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
    let has_build_flags = false;
    let has_regs = false;
    if (trace_version === "1") {
      // '1' - original. uses 7 char hash with VLQ encoded stack-frames
    } else if (trace_version === "2") {
      // '2' - same as '1' but this build is known to be a canary build
      is_canary = true;
    } else if (trace_version === "3") {
      // '3' - '1' plus a build-flags VLQ after the sha (bit0 = canary) and a
      //       trailing register block (StackLine pc, VLQ count, count * 2-VLQ
      //       regs) for fault reasons '2'..'7' only.
      has_build_flags = true;
      has_regs = true;
    } else {
      DEBUG && debug("invalid version '%s'", trace_version);
      return null;
    }

    const addresses: ParsedAddress[] = [];

    let i = first_slash + 4 + 7;

    const commitish = str.slice(first_slash + 4, i);

    if (has_build_flags) {
      const [flags, adv] = decodePart(str.slice(i));
      if (flags == null) {
        DEBUG && debug("invalid build_flags %o", str.slice(i));
        return null;
      }
      i += adv;
      is_canary = !!(flags & (1 << 0));
    }

    const [f0, a0] = decodePart(str.slice(i));
    i += a0;
    const [f1, a1] = decodePart(str.slice(i));
    i += a1;
    if (f0 == null || f1 == null) {
      DEBUG && debug("invalid features part %o", str.slice(i));
      return null;
    }
    const features_data = [f0, f1] as [number, number];

    while (true) {
      if (str[i] === undefined) {
        DEBUG && debug("invalid end of string at %o", i);
        return null;
      }
      const [line, j] = decodeStackLine(str, i);
      i = j;
      if (line === null) {
        DEBUG && debug("invalid stack line %o", str.slice(j));
        return null;
      }
      if (line === "end") break;
      addresses.push(line);
    }

    const reason_char = str[i++];
    const reason = reasons[reason_char];
    if (!reason) {
      DEBUG && debug("invalid reason %o", str.slice(i - 1));
      return null;
    }

    // Reasons "2"–"5" and "b" (trap) encode a fault address. Capture it as a
    // standalone hex string (separate from the human-readable message) so
    // downstream consumers can tag/filter on it without parsing the message.
    let fault_address: string | undefined;
    if ((reason_char >= "2" && reason_char <= "5") || reason_char === "b") {
      const [addr, j] = decodeU64(str, i);
      if (addr == null) {
        DEBUG && debug("invalid fault addr %o", str.slice(i));
        return null;
      }
      fault_address = addr.toString(16).toUpperCase().padStart(8, "0");
      i = j;
    }

    // v3/v4: hardware-fault reasons ('2'..'7') carry a trailing register block.
    let fault_registers: FaultRegisters | undefined;
    if (has_regs && reason_char >= "2" && reason_char <= "7") {
      const [pc_line, j0] = decodeStackLine(str, i);
      if (pc_line === null) {
        DEBUG && debug("invalid reg-block pc %o", str.slice(i));
        return null;
      }
      i = j0;
      const [n, n_inc] = decodePart(str.slice(i));
      if (n == null || n < 0) {
        DEBUG && debug("invalid reg-block count %o", str.slice(i));
        return null;
      }
      i += n_inc;
      const values: bigint[] = [];
      for (let k = 0; k < n; k++) {
        const [v, jv] = decodeU64(str, i);
        if (v == null) {
          DEBUG && debug("invalid reg-block value %d %o", k, str.slice(i));
          return null;
        }
        values.push(v);
        i = jv;
      }
      fault_registers = {
        pc: pc_line === "end" || pc_line.object === "?" ? null : pc_line,
        values,
        names: fault_register_names[values.length] ?? [],
      };
    }

    const message = await reason(fault_address, str.slice(i));
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
      ...(fault_address ? { fault_address } : {}),
      ...(fault_registers ? { fault_registers } : {}),
    };
  } catch (e) {
    DEBUG && debug(e);
    return null;
  }
}

function parsePanicMessage(message_compressed: string): Promise<string> | string {
  if (typeof Bun !== "undefined") {
    try {
      // crash_handler.zig uses zlib.compress2() which emits a zlib-wrapped
      // stream (78 xx header + adler32 trailer). Bun.inflateSync defaults to
      // raw deflate; windowBits:0 enables header auto-detect so both work.
      // @types/bun's ZlibCompressionOptions enumerates 9..15/-9..-15/25..31
      // but omits 0 — the types are wrong, libdeflate accepts it.
      const opts = { windowBits: 0 } as unknown as Bun.ZlibCompressionOptions;
      return "panic: " + new TextDecoder().decode(Bun.inflateSync(Buffer.from(message_compressed, "base64url"), opts));
    } catch (e) {
      console.warn(message_compressed);
      throw e;
    }
  } else {
    const stream = new DecompressionStream("deflate");
    const writer = stream.writable.getWriter();
    const write_promise = writer.write(Uint8Array.from(atob(message_compressed), c => c.charCodeAt(0)));
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
      x => x[1],
      () => "",
    );
  }
}

/**
 * Decode one `StackLine` at `i`. Returns the parsed address, or `"end"` for the
 * bare VLQ(0) frame terminator / `_` unknown sentinel (the encoder writes `_`
 * for an unknown register-block pc; `"A"` only occurs in the frame list), or
 * `null` on malformed input. See `StackLine::write_encoded` in bun's
 * src/crash_handler/lib.rs.
 */
function decodeStackLine(s: string, i: number): [ParsedAddress | "end" | null, number] {
  const c = s[i];
  if (c === "=") return [{ address: 0, object: "js" }, i + 1];
  if (c === "_") return [{ address: 0, object: "?" }, i + 1];
  let [addr, inc] = decodePart(s.slice(i));
  if (addr == null) return [null, i];
  i += inc;
  if (addr === 0) return ["end", i];
  let object = "bun";
  if (addr === 1) {
    const [len, linc] = decodePart(s.slice(i));
    if (len == null) return [null, i];
    i += linc;
    object = s.slice(i, i + len).replace(/^\//, "");
    i += len;
    [addr, inc] = decodePart(s.slice(i));
    if (addr == null) return [null, i];
    i += inc;
  }
  return [{ address: addr, object }, i];
}

/** Decode a u64 encoded as two i32 VLQs (hi, lo) by `write_u64_as_two_vlqs`. */
function decodeU64(s: string, i: number): [bigint | null, number] {
  const [hi, a] = decodePart(s.slice(i));
  if (hi == null) return [null, i];
  const [lo, b] = decodePart(s.slice(i + a));
  if (lo == null) return [null, i];
  return [(BigInt(correctIntToUint32(hi)) << 32n) | BigInt(correctIntToUint32(lo)), i + a + b];
}

function correctIntToUint32(int: number): number {
  return int + (int < 0 ? 2 ** 32 : 0);
}
