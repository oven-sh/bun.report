import type { Parse, Remap } from './lib/parser';

export * from './lib/parser';
export * from './lib/format';

export async function remap(parse: Parse, signal: AbortSignal): Promise<Remap> {
  const response = await fetch('https://bun.report/remap', {
    method: 'POST',
    body: JSON.stringify({
      addresses: parse.addresses,
      os: parse.os,
      arch: parse.arch,
      version: parse.version,
      commitish: parse.commitish,
    }),
    headers: {
      'Content-Type': 'application/json',
    },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(`${response.status} ${response.statusText}\nPlease try again later.`);
  }

  const remap = await response.json();

  if (remap.error) {
    throw new Error(`${remap.error}`);
  }

  return {
    version: parse.version,
    message: parse.message,
    os: parse.os,
    arch: parse.arch,
    commit: remap.commit,
    addresses: remap.addresses,
  }
}
