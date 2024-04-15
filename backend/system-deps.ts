import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const pdb_addr2line =
  process.env.NODE_ENV === 'production'
    ? join(import.meta.dir, './pdb-addr2line')
    : join(import.meta.dir, '..', 'pdb-addr2line/target/release/pdb-addr2line');

if (!existsSync(pdb_addr2line)) {
  throw new Error(`pdb-addr2line missing (expected at ${pdb_addr2line})`);
}

export const xz = Bun.which('xz')!;
if (xz == null) {
  throw new Error(`xz missing`);
}

export const llvm_symbolizer = Bun.which('llvm-symbolizer')!;
if (llvm_symbolizer == null) {
  throw new Error(`llvm-symbolizer missing`);
}
