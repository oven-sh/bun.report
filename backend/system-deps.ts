import { join } from "node:path";
import { existsSync } from "node:fs";

export const pdb_addr2line =
  Bun.which("pdb-addr2line") ??
  (process.env.NODE_ENV === "production"
    ? join(import.meta.dir, "./pdb-addr2line")
    : join(import.meta.dir, "..", "pdb-addr2line/target/release/pdb-addr2line"));

if (!existsSync(pdb_addr2line) && !process.env.SKIP_PDB_ADDR2LINE) {
  console.warn(
    `pdb-addr2line missing (expected at ${pdb_addr2line}, run 'cargo build --release' in pdb-addr2line)`,
  );
}

export const unzip = Bun.which("unzip")!;
if (unzip == null && !process.env.SKIP_UNZIP) {
  console.warn(`unzip missing`);
}

export const llvm_symbolizer = Bun.which("llvm-symbolizer")!;
if (llvm_symbolizer == null && !process.env.SKIP_LLVM_SYMBOLIZER) {
  console.warn(`llvm-symbolizer missing`);
}

export const git = Bun.which("git")!;
if (git == null && !process.env.SKIP_GIT) {
  console.warn(`git missing`);
}
