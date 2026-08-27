// This file manages a in-memory cache of "code views", aka a few lines above and below a given line.
import { SHA256 } from "bun";
import { AsyncMutexMap } from "./mutex";

type FileHash = string;

const MAX_FILES = 20_000;

/** Insertion-ordered map that evicts its oldest entries past `max`. */
function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}

/** commit:path -> hash of file, or null if the file could not be fetched */
const file_hash_map = new Map<string, FileHash | null>();
/** hash of file -> lines of source code */
const file_content_map = new Map<FileHash, string[]>();

const get_file_content_in_progress = new AsyncMutexMap<null | string[]>();

/** bun commit -> zig commit, extracted from scripts/build/zig.ts */
const zig_commit_cache = new Map<string, string | null>();

async function resolveZigCommit(bunCommit: string): Promise<string | null> {
  if (zig_commit_cache.has(bunCommit)) return zig_commit_cache.get(bunCommit)!;
  const res = await fetch(
    `https://raw.githubusercontent.com/oven-sh/bun/${bunCommit}/scripts/build/zig.ts`,
  );
  if (!res.ok) {
    setBounded(zig_commit_cache, bunCommit, null, MAX_FILES);
    return null;
  }
  const m = (await res.text()).match(/ZIG_COMMIT\s*=\s*"([0-9a-f]{40})"/);
  const zigCommit = m?.[1] ?? null;
  setBounded(zig_commit_cache, bunCommit, zigCommit, MAX_FILES);
  return zigCommit;
}

async function resolveSourceUrl(commit: string, path: string): Promise<string | null> {
  // vendor/zig/ is gitignored in bun — fetch from ziglang/zig at the pinned commit.
  const zigLib = path.match(/^vendor\/zig\/(lib\/.*)$/);
  if (zigLib) {
    const zigCommit = await resolveZigCommit(commit);
    if (!zigCommit) return null;
    return `https://raw.githubusercontent.com/oven-sh/zig/${zigCommit}/${zigLib[1]}`;
  }
  return `https://raw.githubusercontent.com/oven-sh/bun/${commit}/${path}`;
}

async function getFileContent(commit: string, path: string): Promise<null | string[]> {
  path = path.replaceAll("\\", "/");

  if (path.includes("WebKit")) return null;

  const key = commit + ":" + path.toLowerCase();
  if (file_hash_map.has(key)) {
    const hash = file_hash_map.get(key);
    if (hash == null) return null;
    const content = file_content_map.get(hash);
    if (content) return content;
    file_hash_map.delete(key);
  }

  return get_file_content_in_progress.get(key, async () => {
    const url = await resolveSourceUrl(commit, path);
    if (!url) {
      setBounded(file_hash_map, key, null, MAX_FILES);
      return null;
    }
    const res = await fetch(url);
    if (!res.ok) {
      // Only remember a definitive "not there"; leave transient failures uncached.
      if (res.status === 404) setBounded(file_hash_map, key, null, MAX_FILES);
      return null;
    }

    const content = await res.text();
    const hash: FileHash = SHA256.hash(content, "hex");
    setBounded(file_hash_map, key, hash, MAX_FILES);

    const existing = file_content_map.get(hash);
    if (existing) return existing;

    const split = content.split("\n");
    setBounded(file_content_map, hash, split, MAX_FILES);
    return split;
  });
}

export interface CodeView {
  above: string[];
  line: string;
  below: string[];
}

export async function getCodeView(
  commit: string,
  path: string,
  line: number,
): Promise<CodeView | null> {
  const lines = await getFileContent(commit, path);
  if (!lines) return null;

  if (line > lines.length) {
    return null;
  }

  const above = lines.slice(line - 3, line - 1);
  const below = lines.slice(line, line + 2);
  return {
    above,
    line: lines[line - 1],
    below,
  };
}
