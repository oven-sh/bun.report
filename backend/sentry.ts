import { MD5 } from "bun";
import type { Address, Parse, Remap } from "../lib";
import { type Platform, type Arch, parseCacheKey } from "../lib/util";
import type * as Sentry from "./sentry-types";
import assert from "node:assert";
import { getCodeView } from "./code-view";

async function remapToPayload(
  parse: Parse,
  remap: Remap,
): Promise<Sentry.Payload> {
  assert(parse.cache_key);

  const event_id = MD5.hash(parse.cache_key, "hex");

  return [
    {
      event_id,
      sent_at: new Date().toISOString(),
      sdk: { name: "sentry.javascript.bun", version: Bun.version },
      trace: {
        environment: process.env.NODE_ENV! as Sentry.NodeEnv,
        public_key: process.env.SENTRY_PUBLIC_KEY!,
      },
    },
    { type: "event" },
    {
      exception: {
        values: [await remapToException(parse, remap)],
      },
      event_id,
      platform: "bun",
      tags: getTags(parse, remap),
      contexts: {
        release: remap.version,
        runtime: {
          name: "bun",
          version: remap.version + "+" + remap.commit.oid.slice(0, 9),
        },
        os: getOSContext(parse.os),
        device: getOSDeviceContext(parse.arch),
      },
      timestamp: new Date().getTime() / 1000,
      environment: "production",
      sdk: {
        integrations: [],
        name: "bun",
        version: Bun.version,
        packages: [],
      },
    },
  ];
}

function getTags(parse: Parse, remap: Remap): any {
  const tags: any = {};

  tags.version = remap.version;
  tags.arch = parse.arch.replace(/_baseline$/, "");

  tags.command = remap.command;

  for (const feature of remap.features) {
    tags[feature] = true;
  }

  if (parse.arch.endsWith("_baseline")) {
    tags.baseline = true;
  }

  return tags;
}

function getOSContext(os: Platform): Sentry.OS {
  switch (os) {
    case "windows":
      return {
        name: "Windows",
      };
    case "macos":
      return {
        name: "macOS",
      };
    case "linux":
      return {
        name: "Linux",
      };
  }
}

function getOSDeviceContext(arch: Arch): Sentry.PayloadEventContexts["device"] {
  return {
    arch,
  };
}

function remapToExceptionType(message: string) {
  if (message.startsWith("panic:")) {
    return {
      type: "Panic",
      value: message.slice("panic:".length).trim(),
    };
  }
  if (message.startsWith("error:")) {
    return {
      type: "ZigError",
      value: message.slice("error:".length).trim(),
    };
  }
  if (message == "Stack overflow") {
    return {
      type: "StackOverflow",
      value: "Stack overflow",
    };
  }
  if (message == "Bun ran out of memory") {
    return {
      type: "OutOfMemory",
      value: "Bun ran out of memory",
    };
  }
  if (message == "Unaligned memory access") {
    return {
      type: "UnalignedMemoryAccess",
      value: "Unaligned memory access",
    };
  }

  let type = message.split(" at ")[0];
  if (type.toLowerCase() === "segmentation fault") {
    type = "Segfault";
  } else {
    type = type
      .split(" ")
      .map((x) => x.charAt(0).toUpperCase() + x.slice(1))
      .join("");
  }

  return {
    type,
    value: message,
  };
}

async function remapToException(
  parse: Parse,
  remap: Remap,
): Promise<Sentry.PayloadException> {
  const { type, value } = remapToExceptionType(parse.message);
  return {
    type,
    value,
    stacktrace: {
      frames: await Promise.all(
        remap.addresses.map((x) => toStackFrame(x, remap.commit.oid)).reverse(),
      ),
      mechanism: {
        type: "generic",
        handled: true,
      },
    },
  };
}

async function toStackFrame(
  address: Address,
  commit: string,
): Promise<Sentry.StackTraceFrame> {
  const { object, function: fn, remapped } = address;
  if (remapped) {
    const { src } = address;
    if (src) {
      const filename = src.file.replaceAll("\\", "/");
      const code_view = await getCodeView(commit, src.file, src.line).catch(() => null);
      return {
        filename,
        lineno: src.line,
        in_app: object === "bun" && !filename.includes("src/deps/zig"),
        function: fn,
        module: object,
        source_link: `https://raw.githubusercontent.com/oven-sh/bun/${commit}/${src.file}#L${src.line}`,
        ...(code_view
          ? {
            pre_context: code_view.above,
            context_line: code_view.line,
            post_context: code_view.below,
          }
          : {}),
      };
    }
  }

  return {
    module: object,
    function: fn ?? "<anonymous>",
    in_app: object === "bun",
  };
}

export async function sendToSentry(parse: Parse, remap: Remap) {
  const url = process.env.SENTRY_DSN;
  if (!url) {
    return;
  }
  parse.cache_key ??= parseCacheKey(parse);
  const event = await remapToPayload(parse, remap);
  const body = event.map((x) => JSON.stringify(x)).join("\n");

  console.log(body);

  await fetch(url, {
    method: "POST",
    body: body,
    verbose: true,
  });
}
