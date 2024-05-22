import type { Address, Parse, ParsedAddress } from "../lib/parser";
import { basename, escapeHTML } from "../lib/util";

function skeleton(mul: number, add: number, i: number) {
  return `<td><span class="skeleton"style="width:${Math.random() * mul + add}px;--delay:${i * 100 - 2e5}ms"aria-hidden="true"`;
}

export function addrsToHTML(
  commit: string,
  addrs: (Address | ParsedAddress)[],
): string[] {
  let unknown_in_a_row = 0;
  let pushUnknown = () => {
    if (unknown_in_a_row > 0) {
      lines.push(
        `<td><span class='js'>${unknown_in_a_row} unknown/js code</span></td>`,
      );
      unknown_in_a_row = 0;
    }
  };

  const lines: string[] = [];

  let i = 0;
  for (const addr of addrs) {
    if (addr.object === "?") {
      unknown_in_a_row++;
      continue;
    }

    pushUnknown();

    lines.push(
      "remapped" in addr
        ? addr.remapped
          ? addr.src
            ? `<td><a href="https://github.com/oven-sh/bun/blob/${commit}/${addr.src.file}#L${addr.src.line}" rel="noopener noreferrer" target="_blank"><code>${escapeHTML(basename(addr.src.file))}<span class='loc'>:${addr.src.line}</span></code></a></td><td><code class='fn'>${htmlFunctionName(addr.function, addr.src.file)}</code></td>`
            : `<td></td><td><code class='fn'>${htmlFunctionName(addr.function)}</code>${addr.object !== "bun" ? ` in ${addr.object}` : ""}</td>`
          : `<td></td><td><code>0x${addr.address.toString(16)}</code>${addr.object !== "bun" ? ` in ${addr.object}` : ""}</td>`
        : `${skeleton(150, 120, i)}>I</span></td>${skeleton(50, 100, i)}>I</span></td>`,
    );

    i++;
  }

  pushUnknown();

  return lines;
}

const mapPart = (x: string, i: number, a: string[]) =>
  `<span${i < a.length - 1 ? ' class="namespace"' : ""}>${escapeHTML(x)}</span>`;

const htmlFunctionName = (str: string, file?: string) =>
  (file ? file.endsWith(".zig") : str.startsWith("src."))
    ? '<span class="kw">fn </span>' + str.split(".").map(mapPart).join(".")
    : str.split("::").map(mapPart).join("::");
