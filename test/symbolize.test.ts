import { describe, test, expect } from "bun:test";
import { Glob } from "bun";
import path from "node:path";
import type { ParsedAddress } from "../lib/parser";
import type { Platform } from "../lib/util";
import { adjustBunAddresses, processSymbolizerOutput } from "../backend/symbolize";

interface SymbolizeFixture {
  description: string;
  os: Platform;
  addresses: ParsedAddress[];
  stdout: string;
}

const dir = path.join(import.meta.dir, "fixtures", "symbolize");
const glob = new Glob("*.json");
const files = [...glob.scanSync({ cwd: dir })].sort();

if (files.length === 0) {
  throw new Error("no symbolize fixtures found in test/fixtures/symbolize/");
}

describe("symbolize fixtures", () => {
  for (const file of files) {
    const fixture = require(path.join(dir, file)) as SymbolizeFixture;

    test(fixture.description, () => {
      expect({
        symbolizer_input: adjustBunAddresses(fixture.addresses, fixture.os),
        addresses: processSymbolizerOutput(fixture.addresses, fixture.stdout),
      }).toMatchSnapshot();
    });
  }
});
