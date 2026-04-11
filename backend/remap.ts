import type { Parse, Remap, ResolvedCommit } from "../lib/parser";
import { getCommit } from "./git";
import { fetchDebugFile } from "./debug-store";
import { getCachedRemap, putCachedRemap } from "./db";
import { parseCacheKey } from "../lib/util";
import { llvm_symbolizer, pdb_addr2line } from "./system-deps";
import { formatMarkdown } from "./markdown";
import { decodeFeatures } from "./feature";
import { AsyncMutexMap } from "./mutex";
import { adjustBunAddresses, processSymbolizerOutput, filterAddresses } from "./symbolize";

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
  q: "UpdateInteractiveCommand",
  k: "PublishCommand",
  A: "AuditCommand",
  W: "WhyCommand",
  F: "FuzzilliCommand",
  _: "(pre-init)",
};

/** This map serves as a sort of "mutex" */
const in_progress_remaps = new AsyncMutexMap<Remap>();

export async function remap(parsed_string: string, parse: Parse): Promise<Remap> {
  if (process.env.NODE_ENV === "development") {
    return remapUncached(parsed_string, parse);
  }
  const key = parseCacheKey(parse);
  const cached = getCachedRemap(key);
  parse.cache_key = key;

  if (cached) {
    cached.addresses = filterAddresses(cached.addresses);
    return cached;
  }

  return in_progress_remaps.get(key, () => remapUncached(parsed_string, parse));
}

export async function remapUncached(
  parsed_string: string,
  parse: Parse,
  opts: { exe?: string; commit?: string } = {},
): Promise<Remap> {
  const commit: ResolvedCommit | null = opts.exe
    ? { oid: opts.commit ?? "unknown", pr: null }
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
    const e: any = new Error(`Could not find debug file for ${parse.os}-${parse.arch} for commit ${parse.commitish}`);
    e.code = "DebugInfoUnavailable";
    throw e;
  }

  let stdout = "";

  const bun_addrs = adjustBunAddresses(parse.addresses, parse.os);
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
      const e: any = new Error("pdb-addr2line failed: " + (await Bun.readableStreamToText(subproc.stderr)));
      e.code = "PdbAddr2LineFailed";
    }

    stdout = await Bun.readableStreamToText(subproc.stdout);
  }

  const mapped_addrs = processSymbolizerOutput(parse.addresses, stdout);

  const key = parseCacheKey(parse);
  let display_version = debug_info.feature_config?.version ?? parse.version;
  if (debug_info.feature_config?.is_canary && !display_version.includes("canary")) {
    display_version += "-canary";
  }
  const features = debug_info.feature_config ? decodeFeatures(parse.features, debug_info.feature_config) : [];

  // Standalone (bun build --compile) binaries report whatever Cli.cmd
  // happened to be set to — '_' on older builds that skipped the assignment,
  // 'a' (AutoCommand) on fixed builds. Neither is a useful label. The feature
  // flag is the real signal, so use it as the source of truth and give these
  // crashes their own transaction name in Sentry so they're distinguishable
  // from `bun run` at a glance.
  const command = features.includes("standalone_executable")
    ? "StandaloneExecutable"
    : (command_map[parse.command] ?? parse.command);

  const remap = {
    version: display_version,
    message: parse.message,
    os: parse.os,
    arch: parse.arch,
    commit: commit,
    addresses: mapped_addrs,
    command,
    features,
    embedder: debug_info.feature_config?.embedder,
  };
  putCachedRemap(key, remap);

  if (process.env.DISCORD_WEBHOOK_URL) {
    const markdown = await formatMarkdown(remap, { source: parsed_string });
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

export { filterAddresses, cleanFunctionName, parsePdb2AddrLineFile } from "./symbolize";
