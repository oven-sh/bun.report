import type { Address, Parse, ParsedAddress } from "./parser";
import { basename, escapeHTML, escmd } from "./util";

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
