import { decisionConformance } from "./tasksConformance.js";
import { MemoryTaskRepository } from "./tasks.js";

decisionConformance("Memory tasks", async () => ({ tasks: new MemoryTaskRepository() }));
