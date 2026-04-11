import { MD5, spawnSync } from "bun";
import type { Address, Parse, Remap } from "../lib";
import type { Platform } from "../lib/util";
import type * as Sentry from "./sentry-types";
import { getCodeView } from "./code-view";

const BUN_REPORT_VERSION =
  spawnSync(["git", "-C", import.meta.dir, "rev-parse", "--short=9", "HEAD"]).stdout.toString().trim() || "unknown";

async function remapToPayload(parse: Parse, remap: Remap, trace_str: string): Promise<Sentry.Payload> {
  const event_id = MD5.hash(parse.cache_key!, "hex");
  const view_url = `https://bun.report/${trace_str}/view`;

  return [
    {
      event_id,
      sent_at: new Date().toISOString(),
      sdk: { name: "bun-report", version: BUN_REPORT_VERSION },
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
      platform: "other",
      release: `bun@${remap.version}+${remap.commit.oid.slice(0, 9)}`,
      dist: buildDist(parse),
      level: "fatal",
      transaction: remap.command,
      tags: { ...getTags(parse, remap), ...(view_url.length <= 200 ? { view_url } : {}) },
      fingerprint: buildFingerprint(parse, remap),
      extra: buildExtra(remap, view_url),
      contexts: {
        runtime: {
          name: "bun",
          version: remap.version + "+" + remap.commit.oid.slice(0, 9),
        },
        os: getOSContext(parse),
        device: getOSDeviceContext(parse),
      },
      timestamp: new Date().getTime() / 1000,
      environment: remap.embedder ?? (parse.is_canary ? "canary" : "production"),
      sdk: {
        integrations: [],
        name: "bun-report",
        version: BUN_REPORT_VERSION,
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
  // cache_key is SHA256(commitish_arch_os_canary_addresses). Before the
  // randomUUID switch, MD5(cache_key) was the event_id — so Sentry deduped
  // identical (stack, build) tuples to one event. Sending it as a tag lets
  // count_unique(cache_key) recover that deduped metric for comparison against
  // the pre-switch baseline, while count() gives actual occurrence volume.
  // Truncated: 16 hex chars of SHA256 = 64 bits, collision-resistant enough.
  if (parse.cache_key) tags.cache_key = parse.cache_key.slice(0, 16);

  tags.command = remap.command;

  for (const feature of remap.features) {
    tags[feature] = true;
  }

  if (parse.arch.endsWith("_baseline")) {
    tags.baseline = true;
  }

  if (!remap.embedder && parse.is_canary) tags.canary = true;

  if (parse.env_flags != null) {
    if (parse.env_flags & 0b0001) tags.wsl = true;
    if (parse.env_flags & 0b0010) tags.musl = true;
    if (parse.env_flags & 0b0100) tags.emulated_x64 = true;
  }

  if (parse.os_version?.[0]) tags.os_version = formatOSVersion(parse.os_version);
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

/**
 * `dist` marks build variants of the same release — same version, same commit,
 * different compile flags. For bun that's baseline (older-CPU target) and musl
 * (Alpine/musl libc). undefined means the standard build for this os/arch.
 */
function buildDist(parse: Parse): string | undefined {
  const parts: string[] = [];
  if (parse.arch.endsWith("_baseline")) parts.push("baseline");
  if (parse.env_flags != null && parse.env_flags & 0b0010) parts.push("musl");
  return parts.length ? parts.join("-") : undefined;
}

function formatOSVersion(v: readonly [number, number, number]): string {
  // Drop trailing zeros so "26.4.0" shows as "26.4".
  const parts = v[2] !== 0 ? v : v[1] !== 0 ? v.slice(0, 2) : v.slice(0, 1);
  return parts.join(".");
}

function getOSContext(parse: Parse): Sentry.OS {
  const name = ({ windows: "Windows", macos: "macOS", linux: "Linux" } as const)[parse.os];
  if (!parse.os_version?.[0]) return { name };

  // Windows encodes as major.minor.build (e.g. 10.0.22631). Build number is
  // what actually distinguishes 23H2 from 24H2 — put it in its own field.
  if (parse.os === "windows") {
    const [maj, min, build] = parse.os_version;
    return { name, version: `${maj}.${min}`, build: build ? String(build) : undefined };
  }
  return { name, version: formatOSVersion(parse.os_version) };
}

/**
 * The "Additional Data" panel on every event. We already resolve the commit
 * to its PR (title, number, branch) in remap.commit.pr — currently thrown
 * away. Surfacing it means clicking any crash shows the PR that introduced
 * the crashing code (or at least, the PR the build was cut from).
 */
function buildExtra(remap: Remap, view_url: string): Record<string, unknown> {
  const extra: Record<string, unknown> = { view_url };
  const pr = remap.commit.pr;
  if (pr) {
    extra.pr_number = pr.number;
    extra.pr_title = pr.title;
    extra.pr_branch = pr.ref;
    extra.pr_url = `https://github.com/oven-sh/bun/pull/${pr.number}`;
  }
  return extra;
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

/**
 * Sentry's default fingerprint hashes the message, which for us includes the
 * fault address ("Segmentation fault at address 0x7FF6..."). That address is
 * per-process even after ASLR stripping if the crash is in a loaded DLL, so
 * identical crashes fragment into thousands of one-event issue groups.
 *
 * This builds a fingerprint from the crash type + the function names of the
 * top in-app frames — what a human would actually use to recognize a crash.
 * The address stays visible in the message; grouping just ignores it.
 *
 * Falls back to Sentry's default when we can't find any remapped in-app
 * frames (e.g. a crash entirely inside an external DLL we can't symbolicate).
 */
function buildFingerprint(parse: Parse, remap: Remap): string[] {
  const { type } = remapToExceptionType(parse.message);

  // Walk from the top of the stack (crash site outward). A frame is usable
  // if we symbolicated it to a real function name — ?? and <anonymous> are
  // symbolication failures, not identities.
  const usable: string[] = [];
  for (const addr of remap.addresses) {
    if (usable.length >= 5) break;
    if (!addr.remapped) continue;
    const fn = addr.function;
    if (!fn || fn === "??" || fn === "<anonymous>") continue;
    usable.push(fn);
  }

  if (usable.length === 0) {
    // No symbolicated frames — punt to Sentry's default so we don't collapse
    // every unsymbolicated crash into one mega-group.
    return ["{{ default }}"];
  }

  // For panics, the panic message IS the identity ("assertion failed: x",
  // "index out of bounds"). Different panic messages are different bugs even
  // if the stack happens to match. Other crash types don't have a meaningful
  // message — it's just "Segfault at 0x..." which we're trying to escape.
  if (type === "Panic") {
    return [type, parse.message, ...usable];
  }

  return [type, ...usable];
}

/**
 * Hardware faults don't carry a meaningful error string — "Segmentation fault
 * at address 0x..." describes what the CPU did, not what the code did.
 * Sentry's docs say to set synthetic:true for these so the UI doesn't try to
 * parse the message as an error class.
 *
 * mechanism.type describes HOW the crash was caught:
 *   - POSIX: sigaction handler → "signal" + meta.signal with the POSIX number
 *   - Windows: AddVectoredExceptionHandler → "veh" + data with the NT code
 *     (Sentry has no Windows-specific meta field; their own minidump path
 *     puts the code name in exception.type, but we keep type cross-platform
 *     and stash the NT code in mechanism.data instead.)
 *
 * Panic/Error/OOM/StackOverflow are software-raised — real message, no signal,
 * no exception code.
 */
function buildMechanism(type: string, os: Platform): Sentry.Mechanism {
  // SIGBUS is 10 on macOS/BSD, 7 on Linux.
  const posix: Record<string, { number: number; name: string }> = {
    Segfault: { number: 11, name: "SIGSEGV" },
    IllegalInstruction: { number: 4, name: "SIGILL" },
    BusError: { number: os === "macos" ? 10 : 7, name: "SIGBUS" },
    FloatingPointException: { number: 8, name: "SIGFPE" },
  };

  // crash_handler.zig:927 maps ExceptionCode → reason; this inverts it.
  const nt: Record<string, { code: number; name: string }> = {
    Segfault: { code: 0xc0000005, name: "EXCEPTION_ACCESS_VIOLATION" },
    IllegalInstruction: { code: 0xc000001d, name: "EXCEPTION_ILLEGAL_INSTRUCTION" },
    StackOverflow: { code: 0xc00000fd, name: "EXCEPTION_STACK_OVERFLOW" },
    UnalignedMemoryAccess: { code: 0x80000002, name: "EXCEPTION_DATATYPE_MISALIGNMENT" },
  };

  if (os === "windows") {
    const exc = nt[type];
    if (!exc) return { type: "generic", handled: false };
    return {
      type: "veh",
      handled: false,
      synthetic: true,
      data: {
        exception_code: "0x" + exc.code.toString(16).toUpperCase(),
        exception_name: exc.name,
      },
    };
  }

  const sig = posix[type];
  if (!sig) return { type: "generic", handled: false };
  return {
    type: "signal",
    handled: false,
    synthetic: true,
    meta: { signal: sig },
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
    mechanism: buildMechanism(type, parse.os),
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
    return {
      function: fn,
      in_app: object === "bun",
      package: object,
    };
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

export async function sendToSentry(parse: Parse, remap: Remap, trace_str: string) {
  const url = process.env.SENTRY_DSN;
  if (!url) {
    return;
  }
  const event = await remapToPayload(parse, remap, trace_str);
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
