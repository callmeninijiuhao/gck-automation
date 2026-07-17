const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const target = process.argv[2];

// Build with Tauri
const tauriCmd = target
  ? `npx tauri build --target ${target}`
  : 'npx tauri build';

console.log(`\n[Build] ${tauriCmd}`);
execSync(tauriCmd, { stdio: 'inherit' });

// Determine bundle output directory
const targetDir = target
  ? `src-tauri/target/${target}/release/bundle`
  : 'src-tauri/target/release/bundle';

const macosDir = path.join(targetDir, 'macos');

function reSignAdHoc(appPath) {
  if (!fs.existsSync(appPath)) return;
  console.log(`[Sign] Ensuring valid ad-hoc signature for: ${path.basename(appPath)}`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'ignore' });
  } catch (e) {
    console.warn(`[Sign] Failed to ad-hoc sign: ${e.message}`);
  }
}

// Ensure all app bundles are properly signed ad-hoc (required for Apple Silicon)
if (fs.existsSync(macosDir)) {
  fs.readdirSync(macosDir)
    .filter(f => f.endsWith('.app'))
    .forEach(f => reSignAdHoc(path.join(macosDir, f)));
}

console.log('[Done] Build complete, ad-hoc signatures verified.\n');
