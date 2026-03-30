// This file manages a in-memory cache of "code views", aka a few lines above and below a given line.
// Values are cached in memory for ever, assuming the bun.report server has a lot of memory.
import { SHA256 } from "bun";
import assert from "node:assert";
import { AsyncMutexMap } from "./mutex";

type FileHash = string;

/** commit:path -> hash of file */
const file_hash_map = new Map<string, FileHash>();
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
    zig_commit_cache.set(bunCommit, null);
    return null;
  }
  const m = (await res.text()).match(/ZIG_COMMIT\s*=\s*"([0-9a-f]{40})"/);
  const zigCommit = m?.[1] ?? null;
  zig_commit_cache.set(bunCommit, zigCommit);
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
  const hash = file_hash_map.get(key);
  if (hash) {
    const content = file_content_map.get(hash);
    assert(content);
    return content;
  }

  return get_file_content_in_progress.get(key, async () => {
    const url = await resolveSourceUrl(commit, path);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;

    const content = await res.text();
    const hash: FileHash = SHA256.hash(content, "hex");
    file_hash_map.set(key, hash);

    if (file_content_map.has(hash)) {
      const result = file_content_map.get(hash);
      assert(result);
      return result;
    }

    const split = content.split("\n");
    file_content_map.set(hash, split);
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

  console.log(line, lines.length);
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
