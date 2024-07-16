import { join } from "path";
import { rmSync, existsSync } from "fs";
import * as lightning from "lightningcss";
// @ts-ignore
import * as html_minifier from "html-minifier";
import * as marked from "marked";

export async function build(mode: string) {
  let in_file = await Bun.file(
    join(import.meta.dir, "./frontend/frontend.ts"),
  ).text();

  // the following transforms should be considered issues
  // in bun's bundler, as it does not support these things:

  // minifier is unable to tree-shake away `x = x!` assertions
  in_file = in_file.replace(
    /^[ \t]*(\w+)[ \t]*=[ \t]*(\w+)[ \t]*!?[ \t]*\n$/gm,
    (stmt, a, b) => (a === b ? "" : stmt),
  );

  // macros are not able to run on template strings with interpolation.
  // here implements a HTML minification macro. this makes it more reasonable to
  // use html template strings, but the strings cannot include a `
  in_file = in_file.replace(
    /\/\*\s*html\s*\*\/\s*\`\s*(.*?)\s*\`/gs,
    (_, item) => `\`${item.replace(/\s+/g, " ")}\``,
  );

  const temp_path = join(import.meta.dir, "./frontend/frontend.tmp.ts");
  await Bun.write(temp_path, in_file);
  using disposable = {
    [Symbol.dispose]: () => {
      try {
        rmSync(temp_path);
      } catch (e) { }
    },
  };

  const result = await Bun.build({
    entrypoints: [temp_path],
    minify:
      mode === "production"
        ? {
          syntax: true,
          whitespace: true,
          identifiers: true,
        }
        : {
          syntax: true,
        },
    define: {
      "process.env.NODE_ENV": JSON.stringify(mode),
      DEBUG: mode === "development" ? "true" : "false",
    },
    naming: {
      entry: "frontend.js",
    },
  });

  if (!result.success) {
    throw new AggregateError(result.logs, "build failed");
  }

  return result.outputs[0];
}

if (import.meta.main) {
  rmSync("dist", { force: true });

  if (!existsSync("pdb-addr2line/target/release/pdb-addr2line")) {
    console.log("Building pdb-addr2line");
    await Bun.$`cd pdb-addr2line && cargo build --release`;
  }

  const js = await (await build("production")).text();

  console.log("minified js: %d bytes gzip", Bun.gzipSync(js).byteLength);

  const css = await Bun.file(
    join(import.meta.dir, "./frontend/style.css"),
  ).arrayBuffer();

  const result = lightning.transform({
    filename: "style.css",
    code: new Uint8Array(css),
    minify: true,
  });
  if (result.warnings.length > 0) {
    console.warn("css minification warnings:", result.warnings);
  }
  console.log(
    "minified css: %d bytes gzip",
    Bun.gzipSync(result.code).byteLength,
  );

  let html = await Bun.file(
    join(import.meta.dir, "./frontend/index.dev.html"),
  ).text();
  // markdown
  const md = await Bun.file(join(import.meta.dir, "./explainer.md")).text();
  html = html.replace(/%md%/g, await marked.marked(md));
  html = html_minifier.minify(html, {
    collapseWhitespace: true,
    removeComments: true,
  });
  // inline js because it is small
  html = html.replace(
    /<script src="\/frontend\.js" type="module"><\/script>/,
    () => `<script type="module">${js}</script>`,
  );
  // inline css because it is small
  html = html.replace(
    /<link rel="stylesheet" href="\/style\.css">/,
    `<style>${result.code}</style>`,
  );

  const server_bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "./backend/index.ts")],
    minify: {
      syntax: true,
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      DEBUG: "false",
    },
    naming: {
      entry: "server.js",
    },
    target: "bun",
    outdir: join(import.meta.dir, "./dist"),
  });
  if (!server_bundle.success) {
    throw new AggregateError(
      server_bundle.logs,
      "Failed to build server bundle",
    );
  }

  console.log(
    "finished html payload: %d bytes raw, %d bytes gzip",
    new TextEncoder().encode(html).byteLength,
    Bun.gzipSync(html).byteLength,
  );

  await Bun.write("dist/index.html", html);
  await Bun.write(
    "dist/pdb-addr2line",
    Bun.file("pdb-addr2line/target/release/pdb-addr2line"),
  );
  await Bun.write("dist/favicon.ico", Bun.file("frontend/favicon.ico"));
}
