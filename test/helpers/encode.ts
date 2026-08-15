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

const platform_char: Record<string, string> = {
  "windows-x86_64": "w",
  "windows-x86_64_baseline": "e",
  "windows-aarch64": "W",
  "macos-x86_64": "m",
  "macos-x86_64_baseline": "b",
  "macos-aarch64": "M",
  "linux-x86_64": "l",
  "linux-x86_64_baseline": "B",
  "linux-aarch64": "L",
  "freebsd-x86_64": "f",
  "freebsd-aarch64": "F",
} satisfies Partial<Record<`${Platform}-${Arch}`, string>>;

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
  | { kind: "oom" }
  | { kind: "abort" }
  | { kind: "trap"; addr_hi: number; addr_lo: number };

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
    case "abort":
      return "a";
    case "trap":
      return "b" + encodeVlq(r.addr_hi) + encodeVlq(r.addr_lo);
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
  trace_version: "1" | "2" | "3" | "4";
  commitish: string;
  /** v3: the bare VLQ after the sha; v4: header field 0. bit0 = canary. */
  build_flags?: number;
  /** v4: the executable's debug id as lowercase hex. Omit for an executable without one. */
  debug_id?: string;
  /**
   * v4: header fields appended after the ones bun emits today, e.g. a tag this
   * decoder does not know, to exercise the skip path.
   */
  extra_header_fields?: [tag: number, chars: string][];
  features?: [number, number];
  addresses: ParsedAddress[];
  reason: ReasonSpec;
  /** v3+, fault reasons only. */
  registers?: { pc: ParsedAddress | null; values: bigint[] };
}

/** The format-4 header, in the order bun's `encode_trace_string` writes it. */
export function encodeHeader(
  opts: Pick<BuildTraceOpts, "build_flags" | "debug_id" | "extra_header_fields">,
): string {
  const fields: [tag: number, chars: string][] = [[0, encodeVlq(opts.build_flags ?? 0)]];
  if (opts.debug_id !== undefined) fields.push([1, opts.debug_id]);
  fields.push(...(opts.extra_header_fields ?? []));
  return (
    encodeVlq(fields.length) +
    fields.map(([tag, chars]) => encodeVlq(tag) + encodeVlq(chars.length) + chars).join("")
  );
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
  if (opts.trace_version === "4") s += encodeHeader(opts);
  s += encodeVlq(f0) + encodeVlq(f1);
  for (const a of opts.addresses) s += encodeStackLine(a);
  s += encodeVlq(0);
  s += encodeReason(opts.reason);
  if (opts.trace_version === "3" && FAULT_REASONS.has(opts.reason.kind)) {
    s += encodeRegisterBlock(opts.registers ?? { pc: null, values: [] });
  }
  return s;
}
