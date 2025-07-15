import { AsyncMutexMap } from "./mutex";
import { getFileAtCommit } from "./git";
import type { Address, ResolvedCommit, Remap } from "../lib/parser";
import { basename, escmd, escmdcode } from "../lib/util";

export async function formatMarkdown(remap: Remap, internal?: { source: string }): Promise<string> {
  return [
    `Bun v${remap.version} (${treeURLMD(remap.commit)}) on ${remap.os} ${remap.arch} [${remap.command}]`,
    "",
    remap.message.replace(/^panic: /, "**panic**: "),
    "",
    ...(await addrsToMarkdown(remap.commit, remap.addresses)).map((l) => `- ${l}`),
    "",
    remap.features.length > 0 ? `Features: ${remap.features.map(escmd).join(", ")}` : "",
    "",
    ...(internal
      ? [`[(see trace)](<https://bun.report/${internal.source.replace(/^\/+/, "")}/view>)`]
      : []),
  ]
    .join("\n")
    .trim()
    .replace(/\n\n+/g, "\n\n");
}

function treeURLMD(commit: ResolvedCommit) {
  // if (commit.pr) {
  //   return `[#${commit.pr.number}](https://github.com/oven-sh/bun/pull/${commit.pr.number})`;
  // }

  return `[\`${commit.oid.slice(0, 7)}\`](<https://github.com/oven-sh/bun/tree/${commit.oid}>)`;
}

async function addrsToMarkdown(commit: ResolvedCommit, addrs: Address[]): Promise<string[]> {
  let unknown_in_a_row = 0;
  let pushUnknown = () => {
    if (unknown_in_a_row > 0) {
      lines.push(`*${unknown_in_a_row} unknown/js code*`);
      unknown_in_a_row = 0;
    }
  };

  const lines: string[] = [];

  for (const addr of addrs) {
    if (addr.object === "?") {
      unknown_in_a_row++;
      continue;
    }

    pushUnknown();

    if (addr.remapped) {
      lines.push(
        `${
          addr.src
            ? `[\`${escmdcode(basename(addr.src.file))}:${addr.src.line}\`](<${await sourceUrl(commit, addr.src)}>): `
            : ""
        }\`${escmdcode(addr.function)}\`${addr.object !== "bun" ? ` in ${addr.object}` : ""}`,
      );
    } else {
      lines.push(
        `??? at \`0x${addr.address.toString(16)}\` ${addr.object !== "bun" ? `in ${addr.object}` : ""}`,
      );
    }
  }

  pushUnknown();

  return lines;
}

// Given a source path at it appears in stack traces, convert to a path in the WebKit repository
// or null if it is not WebKit code
function sourceFileToWebkit(path: string): string | void {
  let match;
  if (path.includes("WebKit/Source/")) {
    // C:/a/WebKit/WebKit/Source/JavaScriptCore/heap/MarkedBlock.h -> Source/JavaScriptCore/heap/MarkedBlock.h
    // /webkitbuild/vendor/WebKit/Source/JavaScriptCore/runtime/CallData.cpp -> Source/JavaScriptCore/runtime/CallData.cpp
    return "Source/" + path.split("WebKit/Source/")[1];
  } else if (path.includes("src/libpas/")) {
    // src/libpas/pas_scavenger.c -> Source/bmalloc/libpas/src/libpas/pas_scavenger.c
    return "Source/bmalloc/libpas/src/libpas/" + path.split("src/libpas/")[1];
  } else if ((match = /(WTF|bmalloc)\/Headers\/(\1)\//i.exec(path))) {
    // WTF/Headers/wtf/Lock.h -> Source/WTF/wtf/Lock.h
    // WTF/Headers/wtf/text/WTFString.h -> Source/WTF/wtf/text/WTFString.h
    // bmalloc/Headers/bmalloc/IsoHeap.h -> Source/bmalloc/bmalloc/IsoHeap.h
    const subpathFromHeaders = path.split(match[0])[1];
    return `Source/${match[1]}/${match[2]}/${subpathFromHeaders}`;
  } else if (path.includes("bun-webkit/include/wtf/")) {
    // C:/buildkite-agent/builds/windows-x64-hetzner-1/bun/bun/build/bun-webkit/include/wtf/Function.h
    return `Source/WTF/wtf/` + path.split("bun-webkit/include/wtf/")[1];
  }
  // C:/buildkite-agent/cache/https---github-com-oven-sh-bun-git/main/windows-x64-build-cpp/webkit-e1a802a2287edfe7f4046a9dd8307c8b59f5d816/include/JavaScriptCore/JSGlobalObject.h
  // (unhandled because `include/JavaScriptCore` is flattened so we can't know if it is in runtime/, heap/, etc.)
}

function sourceFileToZig(path: string): string | void {
  if (path.includes("vendor/zig/lib/std/")) {
    return "lib/std/" + path.split("vendor/zig/lib/std/")[1];
  }
}

const bunToWebkitCommit = new AsyncMutexMap<string>();
const bunToZigCommit = new AsyncMutexMap<string>();

// Look up the commit in an external repository which was used by a certain commit of Bun
// by reading CMake files from the Bun repository.
async function externalCommitMatchingBunCommit(
  // where to cache results of this function
  cache: AsyncMutexMap<string>,
  // bun commit to look up
  bunCommit: ResolvedCommit,
  // cmake file to search in, relative to the bun repo root (e.g. "cmake/tools/SetupWebKit.cmake")
  cmakeFile: string,
  // RegExp to find the commit in the cmake file. must match the commit as group 1.
  cmakeSearch: RegExp,
): Promise<string> {
  return cache.get(bunCommit.oid, async () => {
    // in the future we could tag commits in our forks according to the Bun commits that used them
    // to avoid having to scan CMake files
    const fallback = `bun-${bunCommit.oid}`;
    const file = await getFileAtCommit(bunCommit, cmakeFile);
    if (!file) return fallback;
    const text = file.toString("utf-8");
    const match = cmakeSearch.exec(text);
    if (!match) return fallback;
    return match[1];
  });
}

export async function sourceUrl(
  commit: ResolvedCommit,
  { file, line }: { file: string; line: number },
): Promise<string> {
  const webkitSubpath = sourceFileToWebkit(file);
  if (webkitSubpath !== undefined) {
    const webkitCommit = await externalCommitMatchingBunCommit(
      bunToWebkitCommit,
      commit,
      "cmake/tools/SetupWebKit.cmake",
      /set\(WEBKIT_VERSION ([0-9a-f]{40})\)/,
    );
    return `https://github.com/oven-sh/WebKit/blob/${webkitCommit}/${webkitSubpath}#L${line}`;
  }
  const zigSubpath = sourceFileToZig(file);
  if (zigSubpath !== undefined) {
    const zigCommit = await externalCommitMatchingBunCommit(
      bunToZigCommit,
      commit,
      "cmake/tools/SetupZig.cmake",
      /set\(ZIG_COMMIT "([0-9a-f]{40})"\)/,
    );
    return `https://github.com/oven-sh/zig/blob/${zigCommit}/${zigSubpath}#L${line}`;
  }
  return `https://github.com/oven-sh/bun/blob/${commit.oid}/${file}#L${line}`;
}
