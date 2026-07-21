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

export function encodeU64(v: bigint): string {
  const hi = Number((v >> 32n) & 0xffff_ffffn) | 0;
  const lo = Number(v & 0xffff_ffffn) | 0;
  return encodeVlq(hi) + encodeVlq(lo);
}

export function encodeStackLine(a: ParsedAddress | null): string {
  if (a == null || a.object === "?") return "_";
  if (a.object === "js") return "=";
  if (a.object === "bun") return encodeVlq(a.address);
  return encodeVlq(1) + encodeVlq(a.object.length) + a.object + encodeVlq(a.address);
}

export type ReasonSpec =
  | { kind: "panic"; message: string }
  | { kind: "unreachable" }
  | { kind: "segfault"; addr_hi: number; addr_lo: number }
  | { kind: "stack_overflow" }
  | { kind: "error"; message: string }
  | { kind: "oom" };

function encodeReason(r: ReasonSpec): string {
  switch (r.kind) {
    case "panic": {
      const compressed = deflateSync(Buffer.from(r.message));
      return "0" + compressed.toString("base64url");
    }
    case "unreachable":
      return "1";
    case "segfault":
      return "2" + encodeVlq(r.addr_hi) + encodeVlq(r.addr_lo);
    case "stack_overflow":
      return "7";
    case "error":
      return "8" + r.message;
    case "oom":
      return "9";
  }
}

const FAULT_REASONS = new Set(["segfault", "stack_overflow"]);

function encodeRegisterBlock(r: { pc: ParsedAddress | null; values: bigint[] }): string {
  return encodeStackLine(r.pc) + encodeVlq(r.values.length) + r.values.map(encodeU64).join("");
}

export interface BuildTraceOpts {
  version: string;
  os: Platform;
  arch: Arch;
  command: string;
  trace_version: "1" | "2" | "3";
  commitish: string;
  /** v3+ build-flags VLQ (bit0 = canary). */
  build_flags?: number;
  features?: [number, number];
  addresses: ParsedAddress[];
  reason: ReasonSpec;
  /** v3+, fault reasons only. */
  registers?: { pc: ParsedAddress | null; values: bigint[] };
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
  if (opts.trace_version === "3") s += encodeVlq(opts.build_flags ?? 0);
  s += encodeVlq(f0) + encodeVlq(f1);
  for (const a of opts.addresses) s += encodeStackLine(a);
  s += encodeVlq(0);
  s += encodeReason(opts.reason);
  if (opts.trace_version === "3" && FAULT_REASONS.has(opts.reason.kind)) {
    s += encodeRegisterBlock(opts.registers ?? { pc: null, values: [] });
  }
  return s;
}
