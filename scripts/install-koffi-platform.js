/**
 * Installs the koffi native binding package for a given target platform.
 *
 * koffi ships its native .node binaries as platform-specific optional packages
 * (@koromix/koffi-<os>-<arch>). When cross-building from macOS (e.g. running
 * `electron-builder --win` or `--linux` on a Mac), plain `npm install` only
 * installs the darwin binding, so the packaged app fails at runtime with
 * "Cannot find the native Koffi module".
 *
 * This script force-installs the requested binding(s) into release/app so that
 * electron-builder includes them in the target package. It does not touch
 * package.json or the lockfile.
 *
 * Usage: node scripts/install-koffi-platform.js <os-arch> [<os-arch>...]
 *   e.g. node scripts/install-koffi-platform.js win32-x64 win32-arm64
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const appDir = path.join(__dirname, '..', 'release', 'app');
const appPkg = JSON.parse(
  fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'),
);

const koffiVersion = (appPkg.dependencies && appPkg.dependencies.koffi) || '';
const version = koffiVersion.replace(/^[^0-9]*/, ''); // strip ^/~/>= prefixes

if (!version) {
  console.error(
    'ERROR: koffi is not listed in release/app/package.json dependencies',
  );
  process.exit(1);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('usage: node scripts/install-koffi-platform.js <os-arch>...');
  process.exit(1);
}

for (const target of targets) {
  const pkg = `@koromix/koffi-${target}`;
  console.log(
    `[koffi] Installing ${pkg}@${version} for target "${target}" ...`,
  );
  execSync(
    `npm install ${pkg}@${version} --no-save --no-package-lock --force`,
    {
      cwd: appDir,
      stdio: 'inherit',
    },
  );
}

console.log('[koffi] Platform binding(s) installed.');
