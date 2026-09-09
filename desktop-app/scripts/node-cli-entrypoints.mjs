import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Tauri resource copying may dereference Node's CLI symlinks. A regular
// launcher keeps npm's module-relative imports rooted in its real directory.
export async function prepareNodeCliEntrypoints(nodeRoot, platform) {
  if (platform !== "darwin") return;
  for (const name of ["npm", "npx"]) {
    const cli = `../lib/node_modules/npm/bin/${name}-cli.js`;
    const entry = path.join(nodeRoot, "bin", name);
    await access(path.resolve(path.dirname(entry), cli));
    await rm(entry, { force: true });
    await writeFile(entry, `#!/bin/sh\nbin_dir=\${0%/*}\nexec "$bin_dir/node" "$bin_dir/${cli}" "$@"\n`, { mode: 0o755 });
  }
}
