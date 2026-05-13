import { deflateSync } from "node:zlib";
import type { Platform, Arch } from "../../lib/util";
import type { ParsedAddress } from "../../lib/parser";

const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

export function encodeVlq(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += chars[digit];
  } while (v > 0);
  return out;
}

const platform_char: Record<`${Platform}-${Arch}`, string> = {
  "windows-x86_64": "w",
  "windows-x86_64_baseline": "e",
  "windows-aarch64": "W",
  "macos-x86_64": "m",
  "macos-x86_64_baseline": "b",
  "macos-aarch64": "M",
  "linux-x86_64": "l",
  "linux-x86_64_baseline": "B",
  "linux-aarch64": "L",
};

export type ReasonSpec =
  | { kind: "panic"; message: string }
  | { kind: "unreachable" }
  | { kind: "segfault"; addr_hi: number; addr_lo: number; regs?: bigint[] }
  | { kind: "stack_overflow" }
  | { kind: "error"; message: string }
  | { kind: "oom" };

/** writeU64AsTwoVLQs: encode a u64 as hi-u32 then lo-u32, each as a signed-i32 VLQ. */
function encodeU64(v: bigint): string {
  return encodeVlq(Number(BigInt.asIntN(32, v >> 32n))) + encodeVlq(Number(BigInt.asIntN(32, v & 0xffffffffn)));
}

function encodeReason(r: ReasonSpec, has_regs: boolean): string {
  switch (r.kind) {
    case "panic": {
      const compressed = deflateSync(Buffer.from(r.message));
      return "0" + compressed.toString("base64url");
    }
    case "unreachable":
      return "1";
    case "segfault": {
      let s = "2" + encodeVlq(r.addr_hi) + encodeVlq(r.addr_lo);
      if (has_regs) {
        // VLQ count `n`, then `n` u64s (gp..., pc) each as two VLQs.
        s += encodeVlq(r.regs?.length ?? 0);
        for (const reg of r.regs ?? []) s += encodeU64(reg);
      }
      return s;
    }
    case "stack_overflow":
      return "7";
    case "error":
      return "8" + r.message;
    case "oom":
      return "9";
  }
}

export interface BuildTraceOpts {
  version: string;
  os: Platform;
  arch: Arch;
  command: string;
  trace_version: "1" | "2" | "3";
  /** v3 only: bit0=canary, rest reserved. */
  trace_flags?: number;
  commitish: string;
  features?: [number, number];
  addresses: ParsedAddress[];
  reason: ReasonSpec;
}

export function buildTraceString(opts: BuildTraceOpts): string {
  if (opts.commitish.length !== 7) throw new Error("commitish must be 7 chars");
  const [f0, f1] = opts.features ?? [0, 0];
  let s = "";
  s += opts.version + "/";
  s += platform_char[`${opts.os}-${opts.arch}`];
  s += opts.command;
  s += opts.trace_version;
  s += opts.commitish;
  if (opts.trace_version === "3") s += encodeVlq(opts.trace_flags ?? 0);
  s += encodeVlq(f0) + encodeVlq(f1);
  for (const a of opts.addresses) {
    if (a.object === "js") {
      s += "=";
    } else if (a.object === "?") {
      s += "_";
    } else if (a.object === "bun") {
      s += encodeVlq(a.address);
    } else {
      s += encodeVlq(1);
      s += encodeVlq(a.object.length);
      s += a.object;
      s += encodeVlq(a.address);
    }
  }
  s += encodeVlq(0);
  s += encodeReason(opts.reason, opts.trace_version === "3");
  return s;
}
