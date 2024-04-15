import type { Address, Parse, Remap } from '../lib/parser';
import { getCommit } from './git';
import { fetchDebugFile } from './debug-store';
import { getCachedRemap, putCachedRemap } from './db';
import { cacheKey } from '../lib/util';
import { llvm_symbolizer, pdb_addr2line } from './system-deps';


export async function remap(parse: Parse): Promise<Remap> {
  const key = cacheKey(parse);
  const cached = getCachedRemap(key);
  if (cached) {
    return cached;
  }

  const remap = await remapUncached(parse);
  putCachedRemap(key, remap);
  return remap;
}

const macho_first_offset = 0x100000000;

export async function remapUncached(parse: Parse, opts: { exe?: string } = {}): Promise<Remap> {
  let commit = opts.exe ? 'unknown' : await getCommit(parse.commitish);
  if (!commit) {
    const e: any = new Error(`Could not find commit ${parse.commitish}`);
    e.code = 'DebugInfoUnavailable';
    throw e;
  }

  const exe_path = opts.exe ?? await fetchDebugFile(parse.os, parse.arch, commit);

  if (!exe_path) {
    const e: any = new Error(`Could not find debug file for ${parse.os}-${parse.arch} for commit ${parse.commitish}`);
    e.code = 'DebugInfoUnavailable';
    throw e;
  }

  let lines: string[] = [];

  const bun_addrs = parse.addresses
    .filter(a => a.object === 'bun')
    .map(a => '0x' + (parse.os === 'macos' ? macho_first_offset + a.address : a.address).toString(16));
  if (bun_addrs.length > 0) {
    const cmd = [
      parse.os === 'windows' ? pdb_addr2line : llvm_symbolizer,
      '--exe',
      exe_path,
      ...parse.os !== 'windows'
        ? ['--no-inlines', '--relative-address']
        : ['--llvm'],
      '-f',
      ...bun_addrs
    ];

    console.log('running', cmd.join(' '));

    const subproc = Bun.spawn({
      cmd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if ((await subproc.exited) !== 0) {
      const e: any = new Error(
        'pdb-addr2line failed: '
        + await Bun.readableStreamToText(subproc.stderr)
      );
      e.code = 'PdbAddr2LineFailed';
    }

    const stdout = await Bun.readableStreamToText(subproc.stdout);
    lines = stdout.split('\n');
  }

  const mapped_addrs: Address[] = parse.addresses.map(addr => {
    if (addr.object === 'bun') {
      const fn_line = lines.shift();
      const source_line = lines.shift();
      if (fn_line && source_line) {
        const parsed_line = parsePdb2AddrLineFile(source_line);

        return {
          remapped: true,
          src: parsed_line ? {
            file: parsed_line.file,
            line: parsed_line.line,
          } : null,
          function: cleanFunctionName(fn_line),
          object: 'bun',
        } satisfies Address;
      }
    }

    return {
      remapped: false,
      object: addr.object,
      address: addr.address,
    } satisfies Address;
  });

  return {
    version: parse.version,
    message: parse.message,
    os: parse.os,
    arch: parse.arch,
    commit: parse.commitish,
    addresses: mapped_addrs,
  };
}

export function cleanFunctionName(str: string): string {
  const last_paren = str.lastIndexOf(')');
  if (last_paren === -1) {
    return str;
  }
  let last_open_paren = last_paren;
  let n = 1;
  while (last_open_paren > 0) {
    last_open_paren--;
    if (str[last_open_paren] === ')') {
      n++;
    } else if (str[last_open_paren] === '(') {
      n--;
      if (n === 0) {
        break;
      }
    }
  }
  return str.slice(0, last_open_paren)
    .replace(/\(.+?\)/g, '(...)')
    .replace(/__anon_\d+\b/g, '')
}

export function parsePdb2AddrLineFile(str: string): { file: string, line: number } | null {
  if (str.startsWith('??:')) return null;

  const last_colon = str.lastIndexOf(':');
  if (last_colon === -1) {
    return null;
  }

  const line = Math.floor(Number(str.slice(last_colon + 1)));
  if (isNaN(line)) {
    return null;
  }

  const file_full = str.slice(0, last_colon);
  const file = file_full
    .replace(/\\/g, '/')
    .replace(/.*?\/src\//g, 'src/');

  return { file, line };
}
