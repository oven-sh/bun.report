#!/usr/bin/env bun

import type { ServeOptions } from "bun";
import { parse, type Parse } from "../lib";
import { existsSync } from "node:fs";

// Parse command line arguments
const args = process.argv.slice(2);
let binaryPath: string;
let repoPath: string;
let commit: string;

if (args.length < 3) {
  console.error("Usage: ci-remap-server </path/to/bun-binary> </path/to/bun-repo> <commit ID>");
  process.exit(1);
}

binaryPath = args[0];
repoPath = args[1];
commit = args[2];

if (existsSync(binaryPath + ".dSYM")) {
  binaryPath = binaryPath + ".dSYM";
} else if (existsSync(binaryPath.replace(".exe", ".pdb"))) {
  binaryPath = binaryPath.replace(".exe", ".pdb");
}

process.env.SKIP_GIT = "true";
process.env.SKIP_UNZIP = "true";
process.env.SKIP_LLVM_SYMBOLIZER = process.platform === "win32" ? "true" : undefined;
process.env.SKIP_PDB_ADDR2LINE = process.platform !== "win32" ? "true" : undefined;
process.env.CI_CLONE_DIR = repoPath;

const { formatMarkdown } = await import("../backend/markdown");
const { remapUncached } = await import("../backend/remap");

if (!existsSync(binaryPath)) {
  console.error(`Error: Binary path does not exist: ${binaryPath}`);
  process.exit(1);
}

process.env.NODE_ENV ||= "development";

function getPathname(url: URL) {
  let pathname = url.pathname;

  while (pathname.startsWith("//")) {
    pathname = pathname.slice(1);
  }

  if (pathname === "") {
    return "/";
  }

  return pathname;
}

const uncollectedTraces: Array<
  { failed_parse: string } | { failed_remap: Parse } | { remap: string }
> = [];
const processingTraces: Array<Promise<void>> = [];

async function captureTrace(traceString: string): Promise<void> {
  try {
    const parsed = await parse(traceString);
    if (!parsed) throw new Error("parse returned null");
    try {
      const remap = await remapUncached(traceString, parsed, { exe: binaryPath, commit });
      uncollectedTraces.push({ remap: await formatMarkdown(remap) });
    } catch (e) {
      uncollectedTraces.push({ failed_remap: parsed });
      console.error(e);
    }
  } catch (e) {
    uncollectedTraces.push({ failed_parse: traceString });
    console.error(e);
  }
}

// Server
const server = Bun.serve({
  port: 0,

  async fetch(request) {
    const request_url = new URL(request.url);
    const pathname = getPathname(request_url);
    if (pathname.endsWith("/ack")) {
      const str = pathname.slice(1, -4);
      const promise = captureTrace(str);
      processingTraces.push(promise);
      promise.finally(() => processingTraces.splice(processingTraces.indexOf(promise), -1));
      return new Response("ok");
    } else if (pathname.startsWith("/traces")) {
      await Promise.allSettled(processingTraces);
      const res = new Response(JSON.stringify(uncollectedTraces));
      uncollectedTraces.splice(0);
      return res;
    }

    return new Response("Not found", { status: 404 });
  },
  error(err) {
    console.log(err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  },
} satisfies ServeOptions);

console.log(server.port);
