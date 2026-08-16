export type DistillationTaskStatus = "active" | "deleted";

export type DistillationTaskRecord = {
  id: string;
  creatorId: string;
  name: string;
  brief: string;
  status: DistillationTaskStatus;
  /** Stable Product identity owned by this Task; revisions cannot change it. */
  productId?: string;
  /** Stable DistillationRun lineage. A Task has one; revisions live below it. */
  runId?: string;
  latestRevisionId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type CreateDistillationTaskInput = {
  id: string;
  creatorId: string;
  name: string;
  brief: string;
  productId: string;
};

export type DistillationTaskRepository = {
  createTask(input: CreateDistillationTaskInput): Promise<DistillationTaskRecord>;
  getTask(creatorId: string, taskId: string): Promise<DistillationTaskRecord | undefined>;
  listTasks(creatorId: string): Promise<DistillationTaskRecord[]>;
  updateTaskBrief(creatorId: string, taskId: string, input: { brief: string; expectedUpdatedAt?: string }): Promise<DistillationTaskRecord>;
  softDeleteTask(creatorId: string, taskId: string): Promise<DistillationTaskRecord>;
  setTaskRevision(creatorId: string, taskId: string, input: { runId: string; revisionId: string; productId: string }): Promise<DistillationTaskRecord>;
};

export function isDistillationTaskRepository(value: unknown): value is DistillationTaskRepository {
  return Boolean(value && typeof value === "object"
    && typeof (value as { createTask?: unknown }).createTask === "function"
    && typeof (value as { getTask?: unknown }).getTask === "function"
    && typeof (value as { listTasks?: unknown }).listTasks === "function"
    && typeof (value as { updateTaskBrief?: unknown }).updateTaskBrief === "function"
    && typeof (value as { softDeleteTask?: unknown }).softDeleteTask === "function"
    && typeof (value as { setTaskRevision?: unknown }).setTaskRevision === "function");
}

export function validateTaskText(value: string, label: string, max = 100_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${label} is too long`);
  return normalized;
}
