# [Bun Stack Trace Remapper](https://bun.report)

This is the code that powers [https://bun.report](https://bun.report), a redirect service for [Bun](https://bun.sh) trace strings. See [bun#10203](https://github.com/oven-sh/bun/pull/10203) for more details.

## Development

System dependencies:

- [Bun](https://bun.sh)
- For remapping Windows traces, you need to compile [pdb-addr2line](https://github.com/mstange/pdb-addr2line), which requires a Rust toolchain installed. This is built from source because I noticed existing binaries did not seem to work well.
- For remapping macOS and Linux traces, you need `llvm-symbolizer` installed. This can be installed by having LLVM installed.
- `unzip` is required to unzip downloaded files.

Everything is written in TypeScript. The backend is a `Bun.serve` server with manual routing, using a frameworkless frontend built with `Bun.build`.

- To run a development server, run `bun dev`.
- To prepare production assets, run `bun build.ts`. A standalone package is placed in `dist/`, which can be run by either `bun ./dist/server.js` or `bun start`.

Trace string processing has two stages: parsing and remapping. Parsing has no dependencies, and is implemented in `lib/parser.ts`. Remapping requires debug symbols, which is implemented in `backend/remap.ts`. For information on the format itself, please see `crash_reporter.zig` in Bun itself.

Contents of `lib.ts` can be consumed without any dependencies or tokens, and run in any environment, but since remapping requires the above system dependencies and a GitHub token, `lib.ts` includes a remap function which uses the public `https://bun.report/remap` endpoint.
