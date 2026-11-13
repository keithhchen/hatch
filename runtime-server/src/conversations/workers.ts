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

/** Build waits for one of these; no other worker is ever blocked. */
export type Blocked = { needs_one_of: string[] };

/** Why a worker cannot start yet; nothing when it can. */
export const blockedBy = (entry: AgentEntry): Blocked | undefined =>
  entry.state === "locked" ? { needs_one_of: ["uploads", "interview"] } : undefined;

export const blockedMessage = (workerId: string) => `${workerId} cannot start yet: upload material or do the interview first.`;

/** Node kinds the Expert opens in Studio; the Assistant does not drive them. */
const STUDIO_ONLY: readonly Role[] = ["inspiration", "content-creation"];

/** Keeps `ROLES` and the registry in step: every role the Assistant drives has exactly one public worker. */
export const unmappedRoles = (workers: WorkerRegistry = WORKERS): Role[] => ROLES.filter(role => !STUDIO_ONLY.includes(role) && workers.all.filter(worker => worker.role === role).length !== 1);
