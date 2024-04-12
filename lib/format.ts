import type { Address, Parse, ParsedAddress } from "./parser";
import { basename, escapeHTML } from "./util";

export function addrsToMarkdown(commit: string, addrs: Address[]): string[] {
  let js_in_a_row = 0;

  const lines: string[] = [];

  for (const addr of addrs) {
    if (addr.object === 'js') {
      js_in_a_row++;
      continue;
    }

    if (js_in_a_row > 0) {
      lines.push(js_in_a_row === 1 ? '*javascript code...*' : `*${js_in_a_row} js functions...*`);
      js_in_a_row = 0;
    }

    if (addr.object === 'bun' && addr.remapped) {
      lines.push(`[\`${escmd(basename(addr.file))}:${addr.line}\`: \`${escmd(addr.function)}\`](https://github.com/oven-sh/bun/blob/${commit}/${addr.file}#L${addr.line})`);
    } else if (addr.remapped) {
      lines.push(`\`${escmd(basename(addr.file))}:${addr.line}\`: \`${escmd(addr.function)}\``);
    } else {
      lines.push(`\`0x${addr.address.toString(16)}\`: ${addr.function ? escmd(addr.function) : '???'}`);
    }
  }

  return lines;
}

export function placeholderAddrsToHTML(addrs: ParsedAddress[]): string[] {
  let js_in_a_row = 0;

  const lines: string[] = [];

  let i = 0;
  for (const addr of addrs) {
    if (addr.object === 'js') {
      js_in_a_row++;
      continue;
    }

    if (js_in_a_row > 0) {
      lines.push(`<td><span class='js'>${js_in_a_row === 1 ? 'javascript code' : `${js_in_a_row} javascript functions`}</span></td>`);
      js_in_a_row = 0;
    }

    i++;
    lines.push(`<td><span ${skeleton(150, 120, i)}>I</span></td><td><span ${skeleton(50, 100, i)}>I</span></td>`);
  }

  return lines;
}

function skeleton(mul: number, add: number, i: number) {
  return `class="skeleton"style="width:${Math.random() * mul + add}px;--delay:${i * 100 - 2000}ms"aria-hidden="true"`;
}

export function addrsToHTML(commit: string, addrs: Address[]): string[] {
  let js_in_a_row = 0;

  const lines: string[] = [];

  for (const addr of addrs) {
    if (addr.object === 'js') {
      js_in_a_row++;
      continue;
    }

    if (js_in_a_row > 0) {
      lines.push(`<td><span class='js'>${js_in_a_row === 1 ? 'javascript code' : `${js_in_a_row} javascript functions`}</span></td>`);
      js_in_a_row = 0;
    }

    if (addr.object === 'bun' && addr.remapped) {
      lines.push(
        `<td><a href="https://github.com/oven-sh/bun/blob/${commit}/${addr.file}#L${addr.line}" rel="noopener noreferrer" target="_blank"><code>${escapeHTML(basename(addr.file))}<span class='loc'>:${addr.line}</span></code></a></td><td><code class='fn'>${htmlFunctionName(addr.file, addr.function)}</code></td>`
      )
    } else if (addr.remapped) {
      lines.push(
        `<td><code>${escapeHTML(basename(addr.file))}:${addr.line}</code></td><td><code>${escapeHTML(addr.function)}</code></td>`
      )
    } else {
      lines.push(
        `<td><code>0x${addr.address.toString(16)}</code></td><td><code>${addr.function ? escapeHTML(addr.function) : '???'}</code></td>`
      )
    }
  }

  return lines;
}

export function escmd(str: string): string {
  return str.replace(/[*#\\\(\)\[\]\<\>_\`]/g, '\\$&');
}

export function cacheKey(parse: Parse) {
  return [
    parse.commitish,
    parse.arch,
    parse.os,
    parse.version,
    ...parse.addresses.map(a => a.address.toString(16)),
  ].join('_');
}

const mapPart = (x: string, i: number, a: string[]) =>
  `<span${i < a.length - 1 ? ' class="namespace"' : ''}>${escapeHTML(x)}</span>`;

const htmlFunctionName = (file: string, str: string) =>
  file.endsWith('.zig')
    ? '<span class="kw">fn </span>' + str.split('.').map(mapPart).join('.')
    : str.split('::').map(mapPart).join('::');