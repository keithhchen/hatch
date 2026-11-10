import type { ConversationRepository } from "../conversationRepository.js";

/** Thrown by a write an executor makes after its Run was stopped or taken over. */
export class RunFenced extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is no longer held by this executor`);
    this.name = "RunFenced";
  }
}

/** Which Run a write belongs to, read from the write's own arguments; undefined when it belongs to none. */
type RunOf = (...args: any[]) => string | undefined;

/**
 * Fences an executor: wraps `target` so each listed write first checks that this executor still holds
 * the Run, by executor_id. A stopped executor, or one whose Run another instance took over, can no
 * longer write, whatever it is still in the middle of.
 */
export function fenced<T extends object>(
  target: T,
  executorId: string,
  repository: Pick<ConversationRepository, "holdsRun">,
  writes: { [K in keyof T]?: RunOf }
): T {
  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      const runOf = writes[key as keyof T];
      if (typeof value !== "function") return value;
      if (!runOf) return value.bind(object);
      return async (...args: unknown[]) => {
        const runId = runOf(...args);
        if (runId && !await repository.holdsRun(runId, executorId)) throw new RunFenced(runId);
        return value.apply(object, args);
      };
    }
  });
}
