import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { freePort } from "./util.mjs";

/** A child process whose output is kept for diagnosis. Never logs the environment. */
export class ManagedProcess {
  constructor(label, command, args, { env, cwd }) {
    this.label = label;
    this.output = "";
    this.child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream?.on("data", (chunk) => { this.output += chunk.toString(); if (this.output.length > 400_000) this.output = this.output.slice(-200_000); });
    }
    this.exited = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));
  }
  get alive() { return this.child.exitCode === null && this.child.signalCode === null; }
  get pid() { return this.child.pid; }
  /** `kill -9`: no handlers run, no graceful drain. */
  async kill9() { if (this.alive) this.child.kill("SIGKILL"); return this.exited; }
  async stop() {
    if (!this.alive) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 8_000);
    await this.exited;
    clearTimeout(timer);
  }
  tail(chars = 1500) { return this.output.slice(-chars); }
}

/** A throwaway Postgres 16 cluster on its own port and data directory. */
export class PostgresCluster {
  static BIN = process.env.VERIFY_PG_BIN || "/opt/homebrew/opt/postgresql@16/bin";
  constructor(root, port) { this.root = root; this.port = port; this.dir = path.join(root, "pgdata"); this.env = { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" }; }
  static async start(root) {
    const cluster = new PostgresCluster(root, await freePort());
    await cluster.run("initdb", ["-D", cluster.dir, "-U", "verify", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    await cluster.run("pg_ctl", ["-D", cluster.dir, "-o", `-p ${cluster.port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c max_connections=400 -c fsync=off`, "-l", path.join(root, "pg.log"), "-w", "start"]);
    return cluster;
  }
  run(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(path.join(PostgresCluster.BIN, command), args, { env: this.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      child.on("exit", (code) => code === 0 ? resolve(out) : reject(new Error(`${command} failed: ${out.slice(-800)}`)));
    });
  }
  url(database = "postgres") { return `postgres://verify@127.0.0.1:${this.port}/${database}`; }
  async stop() { await this.run("pg_ctl", ["-D", this.dir, "-m", "immediate", "-w", "stop"]).catch(() => undefined); }
}

export const makeRoot = (label) => mkdtempSync(path.join(os.tmpdir(), `hatch-verify-${label}-`));
export const removeRoot = (root) => rmSync(root, { recursive: true, force: true });
