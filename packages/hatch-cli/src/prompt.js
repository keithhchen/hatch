import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

// Port: interactive, choose(question, [[value, label]]) -> value, secret(question) -> string.
export class TerminalPrompter {
  constructor({ stdin, stderr }) {
    Object.assign(this, { stdin, stderr });
    this.interactive = Boolean(stdin?.isTTY && stderr?.isTTY);
  }

  async choose(question, options) {
    this.stderr.write(`${question}\n${options.map(([, label], i) => `  ${i + 1}) ${label}`).join("\n")}\n`);
    for (;;) {
      const answer = (await this.#ask(`Choose [1-${options.length}] (1): `)).trim() || "1";
      const picked = options[Number(answer) - 1];
      if (picked) return picked[0];
    }
  }

  // The typed characters are not echoed.
  async secret(question) {
    this.stderr.write(question);
    const answer = await this.#ask("", { muted: true });
    this.stderr.write("\n");
    return answer.trim();
  }

  async #ask(question, { muted = false } = {}) {
    const output = muted ? new Writable({ write: (_chunk, _enc, done) => done() }) : this.stderr;
    const rl = createInterface({ input: this.stdin, output, terminal: true });
    try { return await rl.question(question); } finally { rl.close(); }
  }
}

export const NON_INTERACTIVE = { interactive: false };
