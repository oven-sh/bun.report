import { join } from 'node:path';

export const pdb_addr2line =
  process.env.NODE_ENV === 'production'
    ? join(import.meta.dir, './pdb-addr2line')
    : join(import.meta.dir, '..', 'pdb-addr2line2/target/release/pdb-addr2line2');

if (Bun.which(pdb_addr2line) == null) {
  throw new Error(`pdb-addr2line missing`);
}

export const xz = Bun.which('xz')!;
if (xz == null) {
  throw new Error(`xz missing`);
}

export const llvm_symbolizer = Bun.which('llvm-symbolizer')!;
if (llvm_symbolizer == null) {
  throw new Error(`llvm-symbolizer missing`);
}
