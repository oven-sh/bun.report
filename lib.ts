import {
  parse,
  type Parse,
  type Remap,
  type RemapAPIResponse,
} from "./lib/parser";

export * from "./lib/parser";
export * from "./lib/format";

export async function remap(
  key: string,
  parse: Parse,
  signal?: AbortSignal,
): Promise<Remap> {
  const response = await fetch("https://bun.report/remap", {
    method: "POST",
    body: key,
    headers: {
      "Content-Type": "application/json",
    },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(
      `${response.status} ${response.statusText}\nPlease try again later.`,
    );
  }

  const remap = (await response.json()) as RemapAPIResponse | { error: string };

  if ("error" in remap) {
    throw new Error(`${remap.error}`);
  }

  return {
    version: remap.version,
    message: parse.message,
    os: parse.os,
    arch: parse.arch,
    commit: remap.commit,
    addresses: remap.addresses,
    command: remap.command,
    features: remap.features,
  };
}

export async function parseAndRemap(str: string): Promise<Remap | null> {
  const parsed = await parse(str);
  if (!parsed) return null;
  return remap(str, parsed);
}
