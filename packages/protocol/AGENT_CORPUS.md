# Hatch Agent Corpus

`Agent Corpus` 是一位 Creator Agent 的完整、可发布、与 Runtime 解耦的主体。
它回答：**这个 Agent 是谁、卖什么、怎样思考、哪些局部执行能力可用、哪些长尾材料可查、需要哪些工具、如何被验证。**

它不回答：**在哪台机器运行、由哪个模型运行、如何 streaming、怎样 approval、怎样认证、连接到哪个 URL、知识库 index 在哪里、或当前版本是什么。** 这些是 Hatch Runtime / Registry / Control Plane 的责任。

## 四层认知边界

```text
instructions/system.md
  全局世界观、语气、价值判断、产品边界、每次都必须遵守的行为、全局 few-shots。

skills/<skill-id>/SKILL.md
  可选的局部执行单元；仅在这个单元被需要时加载。不是整个产品的 workflow。

skills/<skill-id>/references/*.md
  只在该 Skill 执行时需要的框架、审美、方法或局部 examples。

knowledge/*.md
  retrieval-only 的长尾事实、案例或材料；只在具体请求需要时由 `hatch.file_search` 找回。
```

System / Skill / reference 绝不进入 RAG；全局行为不能为了节省 context 而降级为 retrieval。Skill 可以不存在：一个简单 Agent 可以只有 `system.md`、工具和一个空的 knowledge namespace。

Synthetic QA 也按同一边界处理：影响全局行为的学习进入 `system.md`，局部学习进入对应 Skill/reference，长尾兜底才成为 knowledge。`evaluations` 的 synthetic QA 和 held-out 都是验证资产，**不自动进入 live Runtime context**；held-out 永远不能进入。

## 发布目录

```text
agent-corpus/
├── agent.json
├── instructions/
│   └── system.md
├── skills/                              # optional
│   └── <skill-id>/
│       ├── SKILL.md
│       └── references/                  # optional, local to this Skill
├── knowledge/                           # retrieval-only; may contain no documents
│   └── <document>.md
└── evals/
    ├── synthetic-qa.json
    └── held-out.json
```

`agent.json` 是唯一 manifest。所有被引用的 asset 均为 `{ id, path, sha256, description? }`，其中 `sha256` 是该文件字节的 `sha256:<hex>`。Factory 通过 workspace 文件工具写 assets，并在写 manifest 前取得精确 digest；它不把 assets 打包为一个大 JSON response。

原始课程、PDF、视频、转写、Factory trace、证据 ledger、prompt 草稿、Creator 或 Consumer 数据、密钥和 provider 配置都不是 Corpus 的一部分。

## `agent.json` 的固定组成

| 区块 | 作用 |
|---|---|
| `contract_version`, `creator.id`, `agent_id` | Corpus 身份；无 release/version。`tenant_id` 只属于 Registry 的发布与授权 scope，绝不写入 Corpus。 |
| `creator` | Creator 的 `id` 与显示名 |
| `product` | 最小 required 是 `id`、`name`；`description`、`promise`、inputs、outputs、boundaries、offer 按产品需要声明，且不保证外部现实结果 |
| `instructions.system` | 固定为 `instructions/system.md`，每次运行加载 |
| `skills` | 可省略或 `[]`；每项有 local instruction、可选 references、和 scoped `allowed_tool_ids` |
| `knowledge.documents` | 每个 Agent 都有独立 namespace；可为 `[]`，每项必须是 `knowledge/*.md` 且 `retrieval_only: true` |
| `tools` | Hatch capability 与 Creator HTTP/MCP requirement；不含 URL/secret |
| `evaluations` | 独立的 `synthetic_qa` 与 `held_out` JSON assets；不进 context |

机器可读权威定义为 [`creator-agent.schema.json`](./schemas/creator-agent.schema.json)，`agent-corpus.schema.json` 是相同 contract 的兼容入口。

## 工具与认证

`hatch.web_search` 与 `hatch.file_search` 是每个 Corpus 都必须声明的 Hatch built-in。后者由 Registry 为每个 `creator.id + agent_id` 提供隔离的 retrieval namespace，即使 `knowledge.documents` 为空也保持一致。`hatch.local.*` 只描述 Creator Agent 的产品依赖；它不裁剪 Desktop 在 `client.hello` 中固定声明的完整本地工具集，也不参与 Ask/Allow 决策。Native Workspace grant、Desktop change policy 与本机 runner 才是执行权限边界。

Creator HTTP/MCP 工具分别使用 `kind: "http_function"` 或 `kind: "mcp_tool"`，只声明 `creator.*` 的 id、`connection_ref`、允许的 operation/tool name 和 input schema。没有 URL、API key、OAuth token 或 MCP bearer token。

Tool Control Plane 保存 connection metadata、Agent-to-connection binding 与 `secret_ref`；Secret Manager 保存真正的 credential；Runtime 在单次 tool call 时解析它。Corpus 所有 Markdown、Skill、references、knowledge 和 evals 都保存在 Registry 的 artifact storage，不是 credential database。

## RAG

Registry 在发布时只把 `knowledge.documents` 上传到该 `creator.id + agent_id` 的知识空间，并保存 binding；tenant 仅用于 Registry 授权与 storage scope。Runtime 将当前 binding 暴露为 Hatch-owned `hatch.file_search`。Corpus 因此不包含 `vector_store_id`、chunk 策略、embedding provider 或检索参数；不同 Creator Agent 不共享检索空间。

## Runtime 的职责

Runtime 只在验证通过的 Corpus 之上运行：始终加载 system、先给模型 Skill catalog、仅在执行某 Skill 时加载它的 `SKILL.md + references`、仅在需要证据时调用 `hatch.file_search`，并把 Hatch built-ins、Creator tools 与 Desktop 已声明的完整 local tool set 合并；Corpus 不能减去 Desktop 工具。Kimi 2.6、delta streaming、RAG provider、approval 与 trace 均在 Runtime，不反向污染 Corpus。
