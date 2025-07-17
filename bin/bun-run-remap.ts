#!/usr/bin/env bun
import type { ServeOptions, Subprocess } from "bun";
import { cc } from "bun:ffi";
import { parse } from "../lib";
import { formatMarkdown } from "../backend/markdown";
import { existsSync } from "node:fs";
import source from "./ensure-no-coredump.c" with { type: "file" };
process.env.SKIP_GIT = "true";
process.env.SKIP_UNZIP = "true";
process.env.SKIP_LLVM_SYMBOLIZER = process.platform === "win32" ? "true" : undefined;
process.env.SKIP_PDB_ADDR2LINE = process.platform !== "win32" ? "true" : undefined;
const { remapUncached } = await import("../backend/remap");

const {
  symbols: { ensure_no_coredump: ensureNoCoredump },
} = cc({
  source,
  symbols: {
    ensure_no_coredump: { args: [], returns: "void" },
  },
});

// Parse command line arguments
const args = process.argv.slice(2);
let binaryPath: string | undefined;

if (args.length === 0) {
  console.error("Usage: path/to/bun [...args]");
  process.exit(1);
}

binaryPath = args[0];
const rest = args.slice(1);

// Verify binary path exists
if (binaryPath) {
  if (!existsSync(binaryPath)) {
    console.error(`Error: Binary path does not exist: ${binaryPath}`);
    process.exit(1);
  }
} else {
  // No binary path provided
  console.error("Error: Binary path is required. Use --exe or -e to specify the path.");
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

let subproc: Subprocess | undefined;
let timer: NodeJS.Timeout | undefined;
// Server
const server = Bun.serve({
  port: 0,

  fetch(request, server) {
    const request_url = new URL(request.url);
    const pathname = getPathname(request_url);
    if (pathname.endsWith("/ack")) {
      const str = pathname.slice(1, -4);
      return parse(str)
        .then(async (parsed) => {
          if (!parsed) {
            if (process.env.NODE_ENV === "development") {
              console.log("Invalid trace string sent for ack");
              console.error(pathname.slice(1, -4));
            }
            return new Response("Not found", { status: 404 });
          }

          remapUncached(str, parsed, { exe: binaryPath })
            .then(async (remap) => {
              if (subproc) {
                await subproc.exited;
              }
              console.error("====================");
              console.error("Remapped stack trace");
              console.warn((await formatMarkdown(remap)).split("\n").slice(1).join("\n"));
              console.error("====================");
              server.unref();
              if (timer) {
                clearTimeout(timer);
              }
            })
            .catch((e) => {
              if (process.env.NODE_ENV === "development") {
                console.log("Invalid trace string sent for ack");
                console.error(e);
              }
            });

          return new Response("ok");
        })
        .catch((err) => {
          console.log(err);
          return new Response("ok");
        });
    }

    return new Response("Not found", { status: 404 });
  },
  error(err) {
    console.log(err);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  },
} satisfies ServeOptions);

subproc = Bun.spawn({
  cmd: [binaryPath, ...rest],
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    BUN_CRASH_REPORT_URL: `${server.url.href}`,
  },
});
await subproc.exited;
const exitCode = subproc.exitCode;
const signal = subproc.signalCode;
const wait = exitCode === 0 ? 100 : 500;
subproc = undefined;
timer = setTimeout(() => {
  server.unref();
}, wait);
process.on("beforeExit", () => {
  if (!exitCode) {
    console.error("Raised", signal);
    ensureNoCoredump();
    process.abort();
  }
  process.exitCode = exitCode;
});
