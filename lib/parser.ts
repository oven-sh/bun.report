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

type ReasonResult = string | { message: string; fault_registers?: FaultRegisters; consumed: number };

const reasons: { [key: string]: (input: string, has_regs: boolean) => ReasonResult | Promise<ReasonResult> } = {
  "0": parsePanicMessage,
  "1": () => "panic: reached unreachable code",
  "2": (s, r) => parseFaultReason("Segmentation fault", s, r),
  "3": (s, r) => parseFaultReason("Illegal instruction", s, r),
  "4": (s, r) => parseFaultReason("Bus error", s, r),
  "5": (s, r) => parseFaultReason("Floating point exception", s, r),
  "6": () => `Unaligned memory access`,
  "7": () => `Stack overflow`,
  "8": rest => "error: " + rest,
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
  /**
   * v3+, fault reasons (segfault/SIGILL/SIGBUS/SIGFPE) only: GP register
   * snapshot at the moment of the fault. Register names follow `gp_names`
   * in bun's `crash_handler.zig` (x64: rax..r15; arm64: x0..x28,fp,lr,sp).
   */
  fault_registers?: FaultRegisters;
}

export interface FaultRegisters {
  /** Program counter / instruction pointer at the fault. */
  pc: bigint;
  /** General-purpose registers, indexed parallel to `names`. */
  gp: bigint[];
  /**
   * Register names matching `gp` indices. Derived from arch and gp.length —
   * 16 ⇒ x64, 32 ⇒ arm64. Empty on unrecognised counts (forward compat).
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
    let has_regs = false;
    if (trace_version === "1") {
      // '1' - original. uses 7 char hash with VLQ encoded stack-frames
    } else if (trace_version === "2") {
      // '2' - same as '1' but this build is known to be a canary build
      is_canary = true;
    } else if (trace_version === "3") {
      // '3' - same as '1' but for fault reasons (segfault/SIGILL/SIGBUS/SIGFPE)
      //       a register block follows the fault address: one VLQ count `n`,
      //       then `n` u64 values each as two VLQs, in `FaultRegisters.gp_names`
      //       order followed by pc.
      has_regs = true;
    } else if (trace_version === "4") {
      // '4' - same as '3' but this build is known to be a canary build
      has_regs = true;
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
    const result = await reason(str.slice(i + 1), has_regs);
    if (!result) {
      DEBUG && debug("invalid message %o", str.slice(i));
      return null;
    }
    const { message, fault_registers } =
      typeof result === "string" ? { message: result, fault_registers: undefined } : result;
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
      fault_registers,
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

// Must mirror `FaultRegisters.gp_names` in bun's src/crash_handler/crash_handler.zig.
// prettier-ignore
const gp_names_x64 = [
  "rax", "rbx", "rcx", "rdx", "rdi", "rsi", "rbp", "rsp",
  "r8",  "r9",  "r10", "r11", "r12", "r13", "r14", "r15",
] as const;
// prettier-ignore
const gp_names_arm64 = [
  "x0",  "x1",  "x2",  "x3",  "x4",  "x5",  "x6",  "x7",
  "x8",  "x9",  "x10", "x11", "x12", "x13", "x14", "x15",
  "x16", "x17", "x18", "x19", "x20", "x21", "x22", "x23",
  "x24", "x25", "x26", "x27", "x28", "fp",  "lr",  "sp",
] as const;

/**
 * Parse a fault-type reason body: a u64 fault address, optionally followed
 * (v3+) by a VLQ count `n` and `n` u64 registers (each two VLQs, hi then lo)
 * in `gp_names` order with pc last.
 */
function parseFaultReason(label: string, body: string, has_regs: boolean): ReasonResult {
  const [addr, i0] = decodeU64(body, 0);
  if (addr == null) return `${label} at unknown address`;
  const message = `${label} at address 0x${addr.toString(16).toUpperCase().padStart(8, "0")}`;
  if (!has_regs) return { message, consumed: i0 };

  let i = i0;
  const [n, adv] = decodePart(body.slice(i));
  if (n == null || n < 0) return { message, consumed: i };
  i += adv;
  if (n === 0) return { message, consumed: i };

  const regs: bigint[] = [];
  for (let k = 0; k < n; k++) {
    const [v, ri] = decodeU64(body, i);
    if (v == null) return { message, consumed: i0 };
    regs.push(v);
    i = ri;
  }
  const pc = regs.pop()!;
  const names =
    regs.length === gp_names_x64.length ? gp_names_x64 : regs.length === gp_names_arm64.length ? gp_names_arm64 : [];
  return { message, fault_registers: { pc, gp: regs, names }, consumed: i };
}

/** Decode a u64 encoded as two i32 VLQs (hi, lo) by `writeU64AsTwoVLQs`. */
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
