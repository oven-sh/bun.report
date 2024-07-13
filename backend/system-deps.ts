import { join } from "node:path";
import { existsSync } from "node:fs";

export const pdb_addr2line =
  process.env.NODE_ENV === "production"
    ? join(import.meta.dir, "./pdb-addr2line")
    : join(import.meta.dir, "..", "pdb-addr2line/target/release/pdb-addr2line");

if (!existsSync(pdb_addr2line)) {
  console.warn(`pdb-addr2line missing (expected at ${pdb_addr2line}, run 'cargo build --release' in pdb-addr2line)`);
}

export const unzip = Bun.which("unzip")!;
if (unzip == null) {
  console.warn(`unzip missing`);
}

export const llvm_symbolizer = Bun.which("llvm-symbolizer")!;
if (llvm_symbolizer == null) {
  console.warn(`llvm-symbolizer missing`);
}

export const git = Bun.which("git")!;
if (git == null) {
  console.warn(`git missing`);
}
