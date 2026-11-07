import type { AgentEntry } from "../factoryAgents/definitions.js";
import { ROLES, type Role } from "../factoryAgents/store.js";

/** A worker as outside agents name it. */
export type Worker = { id: string; role: Role };

export class WorkerRegistry {
  constructor(readonly all: readonly Worker[]) {}
  byId(id: string): Worker | undefined { return this.all.find(worker => worker.id === id); }
  byRole(role: Role): Worker | undefined { return this.all.find(worker => worker.role === role); }
  idOf(role: Role): string { return this.byRole(role)?.id ?? role; }
}

/** A new worker is one entry here, in the order Studio shows them. */
export const WORKERS = new WorkerRegistry([
  { id: "research", role: "research" },
  { id: "interview", role: "voice" },
  { id: "builder", role: "generation" },
  { id: "cases", role: "case-generation" },
  { id: "evaluator", role: "evaluator" },
]);

export type Blocked = { missing_required: string[]; needs_one_of: string[] };
type Gap = { missingRequired: Role[]; normalCandidates: Role[]; normalSatisfied: boolean };

/** A dependency gap in public worker ids. */
export const blocked = (gap: Gap, workers: WorkerRegistry = WORKERS): Blocked => ({
  missing_required: gap.missingRequired.map(role => workers.idOf(role)),
  needs_one_of: gap.normalSatisfied ? [] : gap.normalCandidates.map(role => workers.idOf(role)),
});

/** Why a worker cannot start yet; nothing when it can. */
export const blockedBy = (entry: AgentEntry, workers: WorkerRegistry = WORKERS): Blocked | undefined =>
  entry.state === "locked" ? blocked({ missingRequired: entry.availability.missingRequired, normalCandidates: entry.dependencies.normal, normalSatisfied: entry.availability.normal.satisfied }, workers) : undefined;

export const blockedMessage = (workerId: string, reason: Blocked) => {
  const parts = [
    reason.missing_required.length ? `${reason.missing_required.join(", ")} must produce output first` : "",
    reason.needs_one_of.length ? `at least one of ${reason.needs_one_of.join(", ")} must produce output first` : "",
  ].filter(Boolean);
  return `${workerId} cannot start yet: ${parts.join("; ")}.`;
};

/** Keeps `ROLES` and the registry in step: every role has exactly one public worker. */
export const unmappedRoles = (workers: WorkerRegistry = WORKERS): Role[] => ROLES.filter(role => workers.all.filter(worker => worker.role === role).length !== 1);
