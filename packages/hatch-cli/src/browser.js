import { spawn } from "node:child_process";

// Port: open(url) -> void. Best effort; callers also print the URL.
export class SystemBrowser {
  constructor(platform = process.platform) { this.platform = platform; }

  open(url) {
    const [cmd, ...args] = this.platform === "darwin" ? ["open", url]
      : this.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
      : ["xdg-open", url];
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    } catch { /* the printed URL is the fallback */ }
  }
}
