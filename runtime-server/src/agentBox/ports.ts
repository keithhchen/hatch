export type ExecResult = { exitCode: number; stdout: string; stderr: string };

/** One buyer's sandbox: a machine of their own, where the Agent runs commands and keeps files. */
export interface AgentBox {
  /** Runs a shell command in `cwd`. Its output is already bounded; a command still running at the deadline is killed and exits 124. */
  exec(command: string, options: { cwd: string; timeoutSeconds: number; signal?: AbortSignal }): Promise<ExecResult>;
  /** Throws BoxFileMissing when there is no such file. */
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  stop(): Promise<void>;
}

/** Where boxes come from. The names are the identity: one name, one box. */
export interface BoxProvider {
  /** The box with this name, running again if it was stopped; undefined when there is none. */
  find(name: string): Promise<AgentBox | undefined>;
  /** Throws BoxNameTaken when a box already has the name. */
  create(name: string): Promise<AgentBox>;
}

/** The sandbox service cannot be reached or refused: the tool says so, and nothing pretends to run. */
export class BoxUnavailable extends Error {
  constructor(cause?: unknown) {
    super("The execution environment is unavailable. Try again later.", cause === undefined ? undefined : { cause });
    this.name = "BoxUnavailable";
  }
}
export class BoxNameTaken extends Error {}
export class BoxFileMissing extends Error {}
/** A mistake in the call that the model can fix: told back to it as is. */
export class BoxToolError extends Error {}
