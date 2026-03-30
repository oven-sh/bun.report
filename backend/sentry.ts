import type { Address, Parse, Remap } from "../lib";
import type * as Sentry from "./sentry-types";
import { getCodeView } from "./code-view";

async function remapToPayload(parse: Parse, remap: Remap): Promise<Sentry.Payload> {
  const event_id = crypto.randomUUID().replaceAll("-", "");

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
      platform: "native",
      release: `bun@${remap.version}+${remap.commit.oid.slice(0, 9)}`,
      level: "fatal",
      transaction: remap.command,
      tags: getTags(parse, remap),
      contexts: {
        runtime: {
          name: "bun",
          version: remap.version + "+" + remap.commit.oid.slice(0, 9),
        },
        os: getOSContext(parse),
        device: getOSDeviceContext(parse),
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
  tags.commit = remap.commit.oid.slice(0, 9);
  tags.arch = parse.arch.replace(/_baseline$/, "");

  tags.command = remap.command;

  for (const feature of remap.features) {
    tags[feature] = true;
  }

  if (parse.arch.endsWith("_baseline")) {
    tags.baseline = true;
  }

  if (parse.is_canary) tags.canary = true;

  if (parse.env_flags != null) {
    if (parse.env_flags & 0b0001) tags.wsl = true;
    if (parse.env_flags & 0b0010) tags.musl = true;
    if (parse.env_flags & 0b0100) tags.emulated_x64 = true;
  }

  if (parse.os_version) tags.os_version = formatOSVersion(parse.os_version);
  if (parse.total_ram_mb) tags.ram_mb = parse.total_ram_mb;

  if (parse.cpu_flags != null) {
    for (const name of decodeCPUFlags(parse.cpu_flags, parse.arch)) {
      tags[`cpu_${name}`] = true;
    }
  }

  return tags;
}

// Bit layout must match bun's src/bun.js/bindings/CPUFeatures.{cpp,zig}.
// bit 0 is `none`, top bits are padding — both skipped. Append only.
const cpu_flag_names = {
  x86_64: [, "sse42", "popcnt", "avx", "avx2", "avx512"],
  aarch64: [, "neon", "fp", "aes", "crc32", "atomics", "sve"],
} as const;

function decodeCPUFlags(flags: number, arch: string): string[] {
  const names = cpu_flag_names[arch.replace(/_baseline$/, "") as keyof typeof cpu_flag_names];
  if (!names) return [];
  const out: string[] = [];
  for (let bit = 0; bit < names.length; bit++) {
    const name = names[bit];
    if (name && flags & (1 << bit)) out.push(name);
  }
  return out;
}

function formatOSVersion(v: readonly [number, number, number]): string {
  // Drop trailing zeros so "26.4.0" shows as "26.4".
  const parts = v[2] !== 0 ? v : v[1] !== 0 ? v.slice(0, 2) : v.slice(0, 1);
  return parts.join(".");
}

function getOSContext(parse: Parse): Sentry.OS {
  const name = ({ windows: "Windows", macos: "macOS", linux: "Linux" } as const)[parse.os];
  return parse.os_version ? { name, version: formatOSVersion(parse.os_version) } : { name };
}

function getOSDeviceContext(parse: Parse): Sentry.PayloadEventContexts["device"] {
  return {
    arch: parse.arch,
    ...(parse.total_ram_mb ? { memory_size: parse.total_ram_mb * 1024 * 1024 } : {}),
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
      .map(x => x.charAt(0).toUpperCase() + x.slice(1))
      .join("");
  }

  return {
    type,
    value: message,
  };
}

async function remapToException(parse: Parse, remap: Remap): Promise<Sentry.PayloadException> {
  const { type, value } = remapToExceptionType(parse.message);
  return {
    type,
    value,
    stacktrace: {
      frames: await Promise.all(remap.addresses.map(x => toStackFrame(x, remap.commit.oid)).reverse()),
    },
    mechanism: {
      type: "generic",
      handled: false,
    },
  };
}

function repoRelativePath(filename: string): string | null {
  // Debug symbols encode absolute build paths; strip known prefixes so source_link
  // points at a real file in the repo. Return null when the file lives outside the
  // bun repo (vendor/zig stdlib, system headers, etc.).
  const stripped = filename
    .replace(/^\/?(webkitbuild|build|workdir)\//, "")
    .replace(/^.*?\/(src|vendor|packages)\//, "$1/");
  if (stripped.startsWith("src/") || stripped.startsWith("vendor/") || stripped.startsWith("packages/")) {
    return stripped;
  }
  return null;
}

async function toStackFrame(address: Address, commit: string): Promise<Sentry.StackTraceFrame> {
  const { object, function: fn, remapped } = address;
  if (remapped) {
    const { src } = address;
    if (src) {
      const filename = src.file.replaceAll("\\", "/");
      const repoPath = repoRelativePath(filename);
      const code_view = await getCodeView(commit, src.file, src.line).catch(() => null);
      return {
        filename,
        lineno: src.line,
        in_app: object === "bun" && !filename.includes("src/deps/zig"),
        function: fn,
        package: object,
        ...(repoPath
          ? {
              source_link: `https://raw.githubusercontent.com/oven-sh/bun/${commit}/${repoPath}#L${src.line}`,
            }
          : {}),
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
    package: object,
    function: fn ?? "<anonymous>",
    in_app: object === "bun",
    ...("address" in address ? { instruction_addr: "0x" + address.address.toString(16) } : {}),
  };
}

async function fetchEventDetails(eventId: string): Promise<any> {
  const response = await fetch(`https://sentry.io/api/0/organizations/4507155222364160/eventids/${eventId}/`, {
    headers: {
      Authorization: `Bearer ${process.env.SENTRY_PRIVATE_KEY}`,
    },
  });
  if (!response.ok) {
    return { id: eventId };
  }
  const json = await response.json();
  const groupId = json?.groupId;
  if (!groupId) {
    return { id: eventId };
  }

  const issueResponse = await fetch(`https://sentry.io/api/0/issues/${groupId}/`, {
    headers: {
      Authorization: `Bearer ${process.env.SENTRY_PRIVATE_KEY}`,
    },
  });
  if (!issueResponse.ok) {
    return { id: eventId };
  }
  const { shortId, permalink } = await issueResponse.json();
  if (!shortId || !permalink) {
    return { id: eventId };
  }

  return {
    groupId,
    shortId,
    permalink,
  };
}

export async function sendToSentry(parse: Parse, remap: Remap) {
  const url = process.env.SENTRY_DSN;
  if (!url) {
    return;
  }
  const event = await remapToPayload(parse, remap);
  const body = event.map(x => JSON.stringify(x)).join("\n");

  console.log(body);

  const response = await fetch(url, {
    method: "POST",
    body: body,
    verbose: true,
  });

  // https://${domain}.sentry.io/issues/?query=${id}
  const json = await response.json();
  const id = json?.id;
  if (!id) {
    return null;
  }

  const result = await fetchEventDetails(id);
  if (!result) {
    return { id };
  }

  return result;
}
