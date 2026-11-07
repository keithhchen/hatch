import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Port: get(profile) / put(profile, entry) / delete(profile) -> Promise.
export class FileCredentialStore {
  constructor(path) { this.path = path; }

  static atHome(home) { return new FileCredentialStore(join(home, ".config", "hatch", "credentials.json")); }

  async #load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8"));
      return { profiles: parsed.profiles ?? {} };
    } catch (error) {
      if (error.code === "ENOENT") return { profiles: {} };
      throw error;
    }
  }

  async #save(doc) {
    const dir = dirname(this.path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async get(profile) { return (await this.#load()).profiles[profile] ?? null; }

  async put(profile, entry) {
    const doc = await this.#load();
    doc.profiles[profile] = entry;
    await this.#save(doc);
  }

  async delete(profile) {
    const doc = await this.#load();
    const existed = profile in doc.profiles;
    delete doc.profiles[profile];
    if (existed) await this.#save(doc);
    return existed;
  }
}
