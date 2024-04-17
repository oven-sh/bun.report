import type { Address, ResolvedCommit } from "./parser";
import { basename, escmdcode } from "./util";

import type { Remap } from "./parser";

export function formatMarkdown(remap: Remap): string {
  return [
    `Bun v${remap.version} (${treeURLMD(remap.commit)}) on ${remap.os} ${remap.arch}:`,
    '',
    remap.message.replace(/^panic: /, '**panic**: '),
    '',
    ...addrsToMarkdown(remap.commit.oid, remap.addresses)
      .map(l => `- ${l}`)
  ].join('\n');
}

function treeURLMD(commit: ResolvedCommit) {
  if (commit.pr) {
    return `[#${commit.pr.number}](https://github.com/oven-sh/bun/pull/${commit.pr.number})`;
  }

  return `[\`${commit.oid.slice(0, 7)}\`](https://github.com/oven-sh/bun/tree/${commit.oid})`
}

export function addrsToMarkdown(commit: string, addrs: Address[]): string[] {
  let js_in_a_row = 0;
  let pushJS = () => {
    if (js_in_a_row > 0) {
      lines.push(`*${js_in_a_row === 1 ? 'javascript code' : `${js_in_a_row} javascript functions`}*`);
      js_in_a_row = 0;
    }
  }

  const lines: string[] = [];

  for (const addr of addrs) {
    if (addr.object === 'js') {
      js_in_a_row++;
      continue;
    }

    pushJS();

    if (addr.remapped) {
      lines.push(`${addr.src ?
        `[\`${escmdcode(basename(addr.src.file))}:${addr.src.line}\`](https://github.com/oven-sh/bun/blob/${commit}/${addr.src.file}#L${addr.src.line}): `
        : ''
        }\`${escmdcode(addr.function)}\`${addr.object !== 'bun' ? ` in ${addr.object}` : ''}`);
    } else {
      lines.push(`??? at \`0x${addr.address.toString(16)}\` ${addr.object !== 'bun' ? `in ${addr.object}` : ''}`);
    }
  }

  pushJS();

  return lines;
}

export function addrsToPlainText(commit: string, addrs: Address[]): string[] {
  let js_in_a_row = 0;
  let pushJS = () => {
    if (js_in_a_row > 0) {
      lines.push(`${js_in_a_row === 1 ? 'javascript code' : `${js_in_a_row} javascript functions`}`);
      js_in_a_row = 0;
    }
  }

  const lines: string[] = [];

  for (const addr of addrs) {
    if (addr.object === 'js') {
      js_in_a_row++;
      continue;
    }

    pushJS();

    if (addr.remapped) {
      lines.push(`${addr.src ?
        `${escmdcode(basename(addr.src.file))}:${addr.src.line} – `
        : ''
        }${addr.function}${addr.object !== 'bun' ? ` in ${addr.object}` : ''}`);
    } else {
      lines.push(`??? at 0x${addr.address.toString(16)} ${addr.object !== 'bun' ? `in ${addr.object}` : ''}`);
    }
  }

  pushJS();

  return lines;
}
