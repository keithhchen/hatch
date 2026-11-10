/** The executor on whose behalf a write is made: the write itself checks, in the same statement, that it still holds the Run. */
export type RunHold = { heldBy: string };

/** Thrown by a write an executor makes after its Run was stopped or taken over. */
export class RunFenced extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is no longer held by this executor`);
    this.name = "RunFenced";
  }
}
