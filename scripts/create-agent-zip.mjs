import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";

const input = path.resolve(process.argv[2] ?? "/input");
const output = path.resolve(process.argv[3] ?? "/output/agent.zip");
const files = {};

async function walk(current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (entry.isFile()) files[path.relative(input, absolute).replaceAll(path.sep, "/")] = await readFile(absolute);
  }
}

await walk(input);
await writeFile(output, zipSync(files, { level: 6 }));
console.log(output);
