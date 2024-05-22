export type EncodedFeatureList = [number, number];

export interface FeatureConfig {
  features: string[];
  version?: string;
  is_canary?: boolean;
  revision?: string;
  generated_at?: number;
  is_pr: boolean;
}

export function decodeFeatures(
  [high, low]: EncodedFeatureList,
  config: FeatureConfig,
): string[] {
  return extractBits(high)
    .map((i) => i + 32)
    .concat(extractBits(low))
    .map((i) => config.features[i]);
}

function extractBits(int: number): number[] {
  const bits = [];
  // top bit is sign
  const top_bit = int < 0;
  // rest
  for (let i = 0; i < 32; i++) {
    if (int & 1) {
      bits.push(i);
    }
    int >>= 1;
    if (int === 0) break;
  }
  if (top_bit) bits.push(31);
  return bits;
}

// test('extractBits', () => {
//   assert.deepEqual(extractBits(0), []);
//   assert.deepEqual(extractBits(1), [0]);
//   assert.deepEqual(extractBits(2), [1]);
//   assert.deepEqual(extractBits(3), [0, 1]);
//   assert.deepEqual(extractBits(0b1001110110110110110), [
//     1,
//     2,
//     4,
//     5,
//     7,
//     8,
//     10,
//     11,
//     13,
//     14,
//     15,
//     18
//   ]);
// });

// test('decodeFeatures', () => {
//   const config: FeatureConfig = {
//     features: ["Bun.stderr", "Bun.stdin", "Bun.stdout", "abort_signal", "bunfig", "define", "dotenv", "external", "extracted_packages", "fetch", "filesystem_router", "git_dependencies", "html_rewriter", "http_server", "https_server", "lifecycle_scripts", "loaders", "lockfile_migration_from_package_lock", "macros", "origin", "shell", "spawn", "standalone_shell", "transpiler_cache", "tsconfig_paths", "tsconfig", "virtual_modules", "WebSocket"],
//   };
//   expect(decodeFeatures([0, 50331664], config)).toEqual([]);
// });
