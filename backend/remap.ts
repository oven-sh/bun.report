import type { Address, Parse, Remap, ResolvedCommit } from "../lib/parser";
import { getCommit } from "./git";
import { fetchDebugFile } from "./debug-store";
import { getCachedRemap, putCachedRemap } from "./db";
import { parseCacheKey } from "../lib/util";
import { llvm_symbolizer, pdb_addr2line } from "./system-deps";
import { formatMarkdown } from "../lib";
import { decodeFeatures } from "./feature";
import { AsyncMutexMap } from "./mutex";

const command_map: { [key: string]: string } = {
  I: "AddCommand",
  a: "AutoCommand",
  b: "BuildCommand",
  B: "BunxCommand",
  c: "CreateCommand",
  D: "DiscordCommand",
  g: "GetCompletionsCommand",
  h: "HelpCommand",
  j: "InitCommand",
  v: "InfoCommand",
  i: "InstallCommand",
  C: "InstallCompletionsCommand",
  l: "LinkCommand",
  P: "PackageManagerCommand",
  R: "RemoveCommand",
  r: "RunCommand",
  n: "RunAsNodeCommand",
  t: "TestCommand",
  U: "UnlinkCommand",
  u: "UpdateCommand",
  p: "UpgradeCommand",
  G: "ReplCommand",
  w: "ReservedCommand",
  e: "ExecCommand",
  x: "PatchCommand",
  z: "PatchCommitCommand",
  o: "OutdatedCommand",
  k: "PublishCommand",
  A: "AuditCommand",
  W: "WhyCommand",
};

/** This map serves as a sort of "mutex" */
const in_progress_remaps = new AsyncMutexMap<Remap>();

export async function remap(parsed_string: string, parse: Parse): Promise<Remap> {
  const key = parseCacheKey(parse);
  const cached = getCachedRemap(key);
  parse.cache_key = key;

  if (cached) {
    cached.addresses = filterAddresses(cached.addresses);
    return cached;
  }

  return in_progress_remaps.get(key, () => remapUncached(parsed_string, parse));
}

const macho_first_offset = 0x100000000;

export async function remapUncached(
  parsed_string: string,
  parse: Parse,
  opts: { exe?: string } = {},
): Promise<Remap> {
  const commit: ResolvedCommit | null = opts.exe
    ? { oid: "unknown", pr: null }
    : await getCommit(parse.commitish);
  if (!commit) {
    const e: any = new Error(`Could not find commit ${parse.commitish}`);
    e.code = "DebugInfoUnavailable";
    throw e;
  }

  const debug_info = opts.exe
    ? {
        file_path: opts.exe,
        feature_config: null,
      }
    : await fetchDebugFile(parse.os, parse.arch, commit, parse.is_canary);

  if (!debug_info) {
    const e: any = new Error(
      `Could not find debug file for ${parse.os}-${parse.arch} for commit ${parse.commitish}`,
    );
    e.code = "DebugInfoUnavailable";
    throw e;
  }

  let lines: string[] = [];

  const bun_addrs = parse.addresses
    .filter((a) => a.object === "bun")
    .map(
      (a) =>
        "0x" + (parse.os === "macos" ? macho_first_offset + a.address : a.address).toString(16),
    );
  if (bun_addrs.length > 0) {
    const cmd = [
      parse.os === "windows" ? pdb_addr2line : llvm_symbolizer,
      "--exe",
      debug_info.file_path,
      ...(parse.os !== "windows" ? ["--no-inlines", "--relative-address"] : ["--llvm"]),
      "-f",
      ...bun_addrs,
    ];

    // console.log("running", cmd.join(" "));

    const subproc = Bun.spawn({
      cmd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });

    if ((await subproc.exited) !== 0) {
      const e: any = new Error(
        "pdb-addr2line failed: " + (await Bun.readableStreamToText(subproc.stderr)),
      );
      e.code = "PdbAddr2LineFailed";
    }

    const stdout = await Bun.readableStreamToText(subproc.stdout);
    lines = stdout.split("\n").filter((l) => l.length > 0);
  }

  let mapped_addrs: Address[] = parse.addresses.map((addr) => {
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

  const old = mapped_addrs.slice();
  // This appears pretty often, and it does not provide much value
  if (mapped_addrs[0]?.function?.includes("WTF::jscSignalHandler")) {
    const old = mapped_addrs.slice();

    mapped_addrs.shift();

    console.log(mapped_addrs);
    // remove additional `???` lines
    while (
      mapped_addrs.length > 0 &&
      (!mapped_addrs[0].remapped || mapped_addrs[0].function === "??")
    ) {
      mapped_addrs.shift();
    }

    // if this operation somehow removes all addresses, revert
    if (mapped_addrs.length === 0) {
      mapped_addrs = old;
    }
  }

  mapped_addrs = filterAddresses(mapped_addrs);

  const key = parseCacheKey(parse);
  let display_version = debug_info.feature_config?.version ?? parse.version;
  if (debug_info.feature_config?.is_canary && !display_version.includes("canary")) {
    display_version += "-canary";
  }
  const remap = {
    version: display_version,
    message: parse.message,
    os: parse.os,
    arch: parse.arch,
    commit: commit,
    addresses: mapped_addrs,
    command: command_map[parse.command] ?? parse.command,
    features: debug_info.feature_config
      ? decodeFeatures(parse.features, debug_info.feature_config)
      : [],
  };
  putCachedRemap(key, remap);

  if (process.env.DISCORD_WEBHOOK_URL) {
    const markdown = formatMarkdown(remap, { source: parsed_string });
    const markdown_no_links = markdown.replaceAll(/\((https?:[^\)]*?)\)/g, "(<$1>)");
    const body = JSON.stringify({
      content: markdown_no_links,
    });
    const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      console.error(await response.text());
    }
  }

  return remap;
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
  while (
    addrs.length > 0 &&
    (!addrs[addrs.length - 1].remapped || addrs[addrs.length - 1].function === "??")
  ) {
    addrs.pop();
  }

  // if this operation somehow removes all addresses, revert
  if (addrs.length === 0) {
    return old;
  }

  return addrs;
}

export function cleanFunctionName(str: string): string {
  const last_paren = str.lastIndexOf(")");
  if (last_paren === -1) {
    return str;
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
  return str
    .slice(0, last_open_paren)
    .replace(/\(.+?\)/g, "(...)")
    .replace(/__anon_\d+\b/g, "");
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

  const file_full = str.slice(0, second_colon);
  const file = file_full.replace(/\\/g, "/").replace(/.*?\/src\//g, "src/");

  return { file, line };
}
