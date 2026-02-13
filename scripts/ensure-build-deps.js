/**
 * Ensures native build tool binaries are present on Windows.
 *
 * When `npm install --omit=optional` is used, rollup and esbuild
 * platform-specific binaries get skipped. This script detects
 * missing binaries and installs only what's needed for the build.
 *
 * Only runs on Windows — macOS/Linux handle this natively.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

if (process.platform !== 'win32') {
  process.exit(0);
}

const missing = [];

const packages = [
  '@rollup/rollup-win32-x64-msvc',
  '@esbuild/win32-x64',
];

for (const pkg of packages) {
  try {
    require.resolve(pkg);
  } catch {
    missing.push(pkg);
  }
}

if (missing.length > 0) {
  console.log(`  Installing build dependencies: ${missing.join(', ')}...`);
  execSync(`npm install --no-save ${missing.join(' ')}`, { stdio: 'inherit' });
}
