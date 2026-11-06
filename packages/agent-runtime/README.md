# @hatch/agent-runtime

An independent TypeScript agent runtime. The core owns conversation/run rules, model-turn and tool-turn phases, message history, and runtime events. Applications supply a session-scoped model, context builder, and tool registry, plus shared persistence and event ports.

## Boundaries

- `src/domain/` contains `Conversation`, `AgentRun`, `ToolInvocation`, and message/state types.
- `src/application/` coordinates domain objects and injected ports.
- `src/ports/` defines the capabilities the runtime needs.
- `src/adapters/` contains optional provider and persistence implementations; the core entrypoint does not import these adapters.

The runtime does not import Hatch product concepts or the existing `runtime-server` package.

## Composition

Construct `AgentRuntime` with shared persistence and event ports. Each consuming application resolves an authorized `RuntimeSession` for a conversation and passes it to `start()`. This keeps model, context, and tools scoped to that session, while the same runtime handles sessions assembled by different downstream consumers.

`RuntimeUnitOfWork.run()` is the transaction boundary. Every repository exposed through its `tx` parameter shares that transaction; returning from the callback commits and returning `T` makes the callback result available to the use case. Model requests and tool executions happen outside this transaction. Storage adapters persist conversation messages and compaction records and can reconstitute `Conversation`, `AgentRun`, and `ToolInvocation` domain objects.

```ts
const runtime = new AgentRuntime({
  unitOfWork,
  events,
  identifiers,
  clock,
});

const session = await sessionAssembler.open(command);
const run = await runtime.start(session, {
  conversationId,
  content: [{ type: "text", text: "Review this image" }, imageBlock],
});

await run.completion;
```

`RuntimeSession` contains a model, context builder, and tool registry. `ContextBuilder` receives the tool catalog and builds the complete `ModelContext` for each request, including system message, selected conversation messages, and available tool definitions. It owns context selection and compaction decisions. Each tool exposes a definition (name, description, and JSON Schema parameters) and implements one asynchronous `execute` method. Expected tool errors return `ToolResult` with `isError: true`; unexpected exceptions propagate to the run. Tools receive an `AbortSignal` and can report progress. `ToolRegistry.list()` supplies definitions to the builder, while `get(name)` resolves model calls to their executor. The runtime persists compaction records after the context builder returns them.

`RunExecution` advances polymorphic `RunPhase` objects. `RequestModelPhase`, `ExecuteToolsPhase`, `AppendAssistantPhase`, and `CancelRunPhase` own phase-specific decisions. The phase driver handles only the generic transition protocol; the domain `AgentRun` enforces valid lifecycle state changes.

## Model adapters

The model adapter subpath translates the runtime's provider-neutral `ModelContext` and model event protocol through Pi AI's provider implementations:

```ts
import {
  KimiModelAdapter,
  GeminiModelAdapter,
  DeepSeekModelAdapter,
} from "@hatch/agent-runtime/adapters/models";

const kimi = new KimiModelAdapter({ apiKey: process.env.MOONSHOT_API_KEY! });
const gemini = new GeminiModelAdapter({ apiKey: process.env.GEMINI_API_KEY! });
const deepseek = new DeepSeekModelAdapter({ apiKey: process.env.DEEPSEEK_API_KEY! });
```

Kimi defaults to `kimi-k2.6` and the China endpoint; `region: "global"` selects Moonshot's global endpoint. Gemini defaults to `gemini-3.8-flash`; DeepSeek defaults to `deepseek-v4-flash`. Each adapter accepts an explicit model ID and common stream settings. API keys are passed by the consuming application's secret/configuration layer.

## Persistence adapters

All three storage implementations satisfy the same callback-based `RuntimeUnitOfWork` contract. The JSONL adapter stores one serialized record per line and atomically replaces the file for each committed transaction. It serializes transactions within one process and is intended for local demonstrations. SQLite and Postgres use database transactions and transaction-scoped repositories.

```ts
import { JsonlRuntimeUnitOfWork, SqliteRuntimeUnitOfWork, PostgresRuntimeUnitOfWork } from
  "@hatch/agent-runtime/adapters/persistence";

const jsonl = await JsonlRuntimeUnitOfWork.open("./data/runtime.jsonl");
const sqlite = SqliteRuntimeUnitOfWork.open("./data/runtime.sqlite");

const postgres = new PostgresRuntimeUnitOfWork(pool);
await postgres.initialize();
```

The SQLite adapter uses Node's built-in `node:sqlite` module and requires Node 22.19 or newer. The Postgres adapter receives a `pg.Pool`; the consuming application owns pool configuration and shutdown.

Use `ToolSet` to assemble tools. Adding a tool means implementing `Tool` and including that object in the set; duplicate names fail during construction.

The runtime waits for model and tool work outside database transactions. A tool call is recorded together with the run's waiting state before the runtime observes the external operation.

## Build

```sh
npm run build
```
