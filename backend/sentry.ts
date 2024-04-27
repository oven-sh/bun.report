import { MD5, SHA1, SHA256 } from "bun";
import type { Address, Remap } from "../lib";
import type * as Sentry from "@sentry/types";

function toStackFrame(address: Address, commit: string): Sentry.StackFrame {
  const { object, remapped } = address;
  if (remapped) {
    const { src, function: fn } = address;
    if (src) {
      const filename = src.file.replaceAll("\\", "/");
      return {
        filename,
        lineno: src.line,
        in_app: object === "bun" && !filename.includes("src/deps/zig"),
        function: fn,
        module: object,
        // @ts-ignore - https://develop.sentry.dev/sdk/event-payloads/stacktrace/
        // source_link: `https://raw.githubusercontent.com/oven-sh/bun/${commit}/${src.file}#L${src.line}`,
      };
    }
  }

  return {
    module: object,
    in_app: object === "bun",
  };
}

function toStackTrace(remap: Remap): Sentry.Stacktrace {
  const {
    addresses,
    commit: { oid: commit },
    os,
    arch,
  } = remap;
  const frames = new Array(addresses.length);
  for (let i = addresses.length - 1; i >= 0; i--) {
    const address = addresses[i];
    frames[i] = toStackFrame(address, commit);
  }

  return {
    frames,
  };
}

function toException(remap: Remap): Sentry.Exception {
  const {
    addresses,
    commit: { oid: commit },
    message,
    os,
    version,
    arch,
    command,
    features,
    issue,
  } = remap;

  return {
    type: "Error",
    value: message,
    stacktrace: toStackTrace(remap),

    // mechanism: {
    //   type: "instrument",
    // },
  };
}

function getOSContext(os: string): Sentry.OsContext {
  switch (os) {
    case "windows":
      return {
        name: "Windows",
        type: "os",
      };
    case "macos":
      return {
        name: "macOS",
        type: "os",
      };
    case "linux":
      return {
        name: "Linux",
        type: "os",
      };
  }

  return {};
}

function toEvent(
  remap: Remap,
  cache_key: string,
  headers: Headers,
  request_ip: string
): Sentry.Event {
  const { os, arch, version, command, features, issue, message } = remap;
  const event_id = MD5.hash(
    new Float64Array([Math.random(), ...Buffer.from(cache_key)]),
    "hex"
  );
  return {
    event_id: event_id,
    sent_at: new Date().toISOString(),
    sdk: { name: "sentry.javascript.bun", version: "7.112.2" },
    trace: {
      environment: process.env.NODE_ENV,
      public_key: process.env.SENTRY_PUBLIC_KEY!,
    },
    platform: `${os}-${arch}`,
    tags: {
      command,
      ...features.reduce((acc, feature) => {
        acc[feature] = true;
        return acc;
      }, {} as any),
      version,
    },
    // version: version,
    // release: version,
    environment: process.env.NODE_ENV,
    timestamp: new Date().getTime(),
    level: "error",
    message: message,
    extra: {
      issue,
      command,
      ...features.reduce((acc, feature) => {
        acc[feature] = true;
        return acc;
      }, {} as any),
    },
    contexts: {
      os: getOSContext(os),
      state: {
        state: {
          type: "Command",
          value: {
            command,
            ...features.reduce((acc, feature) => {
              acc[feature] = true;
              return acc;
            }, {} as any),
          },
        },
      },
    },
    // user: request_ip
    //   ? {
    //       ip_address: request_ip,
    //     }
    //   : undefined,
    // request: headers
    //   ? {
    //       headers: { ...(headers.entries() as any) },
    //     }
    //   : undefined,
  };
}

export async function sendToSentry(
  remap: Remap,
  headers: Headers,
  cache_key: string,
  request_ip: string
) {
  const event = toEvent(
    remap,
    SHA256.hash(cache_key, "hex"),
    headers,
    request_ip
  );
  const type = { type: "event" };
  const exception = {
    exception: {
      values: [toException(remap)],
    },
  };

  const body =
    JSON.stringify(event) +
    "\n" +
    JSON.stringify(type) +
    "\n" +
    JSON.stringify(exception);
  const url = process.env.SENTRY_DSN!;

  await fetch(url, {
    method: "POST",
    body: body,
    verbose: true,
  });
}
