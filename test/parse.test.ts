import { describe, test, expect } from "bun:test";
import { Glob } from "bun";
import path from "node:path";
import { parse } from "../lib/parser";

const dir = path.join(import.meta.dir, "fixtures", "parse");
const glob = new Glob("*.json");
const files = [...glob.scanSync({ cwd: dir })].sort();

if (files.length === 0) {
  throw new Error("no parse fixtures found in test/fixtures/parse/");
}

describe("parse fixtures", () => {
  for (const file of files) {
    const fixture = require(path.join(dir, file)) as { description: string; input: string };

    test(fixture.description, async () => {
      const result = await parse(fixture.input);
      expect(result).not.toBeNull();
      expect(stable(result)).toMatchSnapshot();
    });
  }
});

/** Drop fields that are derived/noisy so snapshots stay readable. */
function stable(p: NonNullable<Awaited<ReturnType<typeof parse>>> | null) {
  if (p == null) return null;
  const { cache_key, ...rest } = p as unknown as Record<string, unknown>;
  return rest;
}
