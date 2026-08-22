import { writeOperationalError } from "./operationalLogging.js";

export type GracefulShutdownOptions = {
  name: string;
  close: () => Promise<void>;
  timeoutMs?: number;
};

/** Install one idempotent, bounded shutdown path for a long-lived process. */
export function installGracefulShutdown(options: GracefulShutdownOptions): void {
  const timeoutMs = options.timeoutMs ?? 30_000;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shutdownPromise) return;
    process.stderr.write(`${JSON.stringify({ event: "shutdown_started", service: options.name, signal })}\n`);
    const timeout = setTimeout(() => {
      writeOperationalError("graceful_shutdown_timeout", new Error(options.name));
      process.exit(1);
    }, timeoutMs);
    timeout.unref();

    shutdownPromise = Promise.resolve().then(() => options.close()).then(
      () => {
        clearTimeout(timeout);
        process.exitCode = 0;
      },
      (error: unknown) => {
        clearTimeout(timeout);
        writeOperationalError("graceful_shutdown_failed", error);
        process.exitCode = 1;
      }
    );
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
