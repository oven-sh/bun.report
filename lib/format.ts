import type { Address } from "./parser";
import { basename, escmd, escmdcode } from "./util";

export const os_names: { [key: string]: string } = {
  w: "Windows",
  m: "macOS",
  l: "Linux",
};

export function addrsToPlainText(commit: string, addrs: Address[]): string[] {
  let unknown_in_a_row = 0;
  let pushUnknown = () => {
    if (unknown_in_a_row > 0) {
      lines.push(`${unknown_in_a_row} unknown/js code`);
      unknown_in_a_row = 0;
    }
  };

  const lines: string[] = [];

  for (const addr of addrs) {
    if (addr.object === "?") {
      unknown_in_a_row++;
      continue;
    }

    pushUnknown();

    if (addr.remapped) {
      lines.push(
        `${
          addr.src ? `${escmdcode(basename(addr.src.file))}:${addr.src.line} – ` : ""
        }${addr.function}${addr.object !== "bun" ? ` in ${addr.object}` : ""}`,
      );
    } else {
      lines.push(
        `??? at 0x${addr.address.toString(16)} ${addr.object !== "bun" ? `in ${addr.object}` : ""}`,
      );
    }
  }

  pushUnknown();

  return lines;
}
