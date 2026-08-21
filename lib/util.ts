import type { Parse, Remap } from "./parser";

// Extracted from @paperdave/utils
// https://github.com/paperdave/various/blob/main/packages/utils/src/debounce.ts
// MIT License
/** Wrap a function and apply debounce logic to. */
export const debounce = <Args extends any[]>(func: (...args: Args) => void, waitTime: number) => {
  let timeout: Timer;

  return (...args: Args) => {
    clearTimeout(timeout);
    timeout = setTimeout(func as any, waitTime, ...args);
  };
};

// Extracted from @paperdave/utils
// https://github.com/paperdave/various/blob/main/packages/utils/src/string.ts
// MIT License
/**
 * Alias of Bun.escapeHTML, polyfilled for other platforms.
 *
 * Escape the following characters in a string:
 *
 * - `"` becomes `"&quot;"`
 * - `&` becomes `"&amp;"`
 * - `'` becomes `"&#x27;"`
 * - `<` becomes `"&lt;"`
 * - `>` becomes `"&gt;"`
 *
 * In bun, this function is optimized for large input. On an M1X, it processes 480 MB/s - 20 GB/s,
 * depending on how much data is being escaped and whether there is non-ascii text.
 */
export const escapeHTML =
  /* @__PURE__ */
  (string: string) => {
    return string
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#x27;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  };

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const basename = (path: string) => path.split("/").pop()!;

export type Platform = "windows" | "linux" | "macos" | "freebsd";

/**
 * The CPU architecture, plus the build variant when a commit is published as
 * more than one binary for that os and cpu. The variant is part of the arch
 * string because everything keyed on (os, arch) (the remap cache key, the
 * debug-file store, the download name) has to tell those binaries apart:
 * `bun-linux-x64`, `bun-linux-x64-musl` and `bun-linux-x64-android` are three
 * different links of the same commit with three different profile zips.
 *
 * `_baseline` is historical: since oven-sh/bun#34782 x64 ships one binary and
 * bun no longer emits the baseline platform characters, but traces from older
 * builds still carry them.
 */
export type Arch =
  | "x86_64"
  | "aarch64"
  | "x86_64_baseline"
  | "x86_64_musl"
  | "aarch64_musl"
  | "x86_64_android"
  | "aarch64_android";

export type Cpu = "x86_64" | "aarch64";
export type ArchVariant = "baseline" | "musl" | "android";

/** Splits an `Arch` into the cpu and the build variant, if it has one. */
export function splitArch(arch: Arch): { cpu: Cpu; variant: ArchVariant | null } {
  const cpu: Cpu = arch.startsWith("aarch64") ? "aarch64" : "x86_64";
  const suffix = arch.slice(cpu.length);
  return { cpu, variant: suffix ? (suffix.slice("_".length) as ArchVariant) : null };
}

/** "x86_64", "x86_64 (musl)": how the footer, the oembed card and Sentry describe an `Arch`. */
export function describeArch(arch: Arch): string {
  const { cpu, variant } = splitArch(arch);
  return variant ? `${cpu} (${variant})` : cpu;
}

/**
 * Computes a cache key to go from a parsed string to the fully remapped data,
 * making it possible to skip file downloading and remapping.
 */
export function parseCacheKey(parse: Parse) {
  const data = [
    parse.commitish,
    parse.arch,
    parse.os,
    !!parse.is_canary,
    ...parse.addresses.map((a) => a.address.toString(16)),
  ].join("_");
  if (typeof Bun !== "undefined") {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(data);
    const buffer = (hasher.digest() as Buffer).toString("base64url");
    return buffer.slice(0, 20);
  }
  return data;
}

/**
 * Computes a cache key unique to the remap. This is used only to
 * tie already remapped crashes to each other. Notably, it is missing
 * the version information, which allows us to track crash status
 * across multiple versions of Bun.
 */
export function remapCacheKey(remap: Remap) {
  const data = [
    remap.os,
    remap.arch,
    ...remap.addresses.flatMap((a) => [
      a.object,
      ...(a.remapped ? [a.function, a.src?.file ?? "no-file"] : [a.address.toString(16)]),
    ]),
  ].join("_");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const buffer = (hasher.digest() as Buffer).toString("base64url");
  return buffer.slice(0, 20);
}

export function escmd(str: string): string {
  return str.replace(/[*#\\\(\)\[\]\<\>_\`]/g, "\\$&");
}

export function escmdcode(str: string): string {
  return str.replace(/[\`]/g, "\\$&");
}
