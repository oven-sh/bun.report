// This file manages a in-memory cache of "code views", aka a few lines above and below a given line.
// Values are cached in memory for ever, assuming the bun.report server has a lot of memory.
import { SHA256 } from "bun";
import assert from "node:assert";

type FileHash = string;

/** commit:path -> hash of file */
const file_hash_map = new Map<string, FileHash>();
/** hash of file -> lines of source code */
const file_content_map = new Map<FileHash, string[]>();

const get_file_content_in_progress = new Map<FileHash, Promise<null | string[]>>();

async function getFileContent(
  commit: string,
  path: string,
): Promise<null | string[]> {
  path = path.replaceAll('\\', '/');

  if (path.includes("WebKit")) return null;
  if (path.includes("src/deps/zig")) return null;

  const key = commit + ":" + path.toLowerCase();
  const hash = file_hash_map.get(key);
  if (hash) {
    const content = file_content_map.get(hash);
    assert(content);
    return content;
  }

  if (get_file_content_in_progress.has(key)) {
    return get_file_content_in_progress.get(key)!;
  }

  const { promise, resolve, reject } = Promise.withResolvers<null | string[]>();
  get_file_content_in_progress.set(key, promise);
  promise.catch(() => { }); // mark as handled

  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/oven-sh/bun/${commit}/${path}`,
    );
    if (!res.ok) {
      get_file_content_in_progress.delete(key);
      resolve(null);
      return null;
    }

    const content = await res.text();
    const hash: FileHash = SHA256.hash(content, "hex");
    file_hash_map.set(key, hash);

    if (file_content_map.has(hash)) {
      const result = file_content_map.get(hash);
      assert(result);
      resolve(result);
      get_file_content_in_progress.delete(key);
      return result;
    }

    const split = content.split("\n");
    file_content_map.set(hash, split);
    resolve(split);
    get_file_content_in_progress.delete(key);
    return split;
  } catch (e) {
    get_file_content_in_progress.delete(key);
    reject(e);
    throw e;
  }
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
