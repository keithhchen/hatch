# Hatch Agent Corpus

`Agent Corpus` 是一个 Creator Agent 发布后交给 Registry 的完整、干净、可移植主体。它回答的是：**这个 Agent 是谁、卖什么、知道什么、会怎样工作、可以要求哪些能力、如何被评估。**

它不回答：**在哪台机器运行、由哪个模型运行、怎样流式传输、如何审批、连接到哪个 URL、怎样认证、使用哪个向量数据库，或当前部署的版本。** 这些都属于 Hatch Runtime / Control Plane。

## 发布目录

```text
agent-corpus/
├── agent.json                       # 唯一 manifest；只引用以下资产
├── instructions/
│   └── system.md                     # 完整 system prompt
├── skills/
│   └── <skill-name>/SKILL.md         # Creator 方法的可执行工作流
├── knowledge/
│   └── <document>.md                 # 已提纯、可检索的 RAG 文档
└── evals/
    └── cases.json                     # source-derived、synthetic、held-out cases
```

`agent.json` 的 `instructions.entrypoint`、`skills.items[].entrypoint`、
`knowledge.documents[].artifact_path` 与 `evals.dataset_path` 只能引用上述
目录内的文件。原始课程、PDF、视频、转写、Factory trace、提示词草稿和内部中间物都不是 Corpus 的一部分。

## `agent.json` 的固定组成

| 区块 | 包含内容 | 不包含内容 |
|---|---|---|
| `agent` | `tenant_id`、`id` | release/version、部署地址 |
| `creator` | Creator 身份和显示名 | Creator 登录凭证 |
| `product` | 用户、承诺、边界、价格、输入和输出契约 | 支付 provider 配置 |
| `instructions` | `instructions/system.md` 的完整 system prompt | 模型名称、temperature、streaming 策略 |
| `skills` | 具名 SKILL.md 及可使用的 tool IDs | 技能 worker/host 实现 |
| `knowledge` | 干净 RAG 文档、来源类型、原始材料 hash 和定位 | vector store/file ID、chunk 策略、检索参数 |
| `tools` | Agent 需要的 Hatch capability，以及 Creator HTTP/MCP 的连接引用和允许操作 | 密钥、URL、approval policy、实际连接 |
| `evals` | `evals/cases.json`：source-derived / synthetic QA；direct、composed、boundary、out-of-scope；few-shot / held-out | 运行 trace、线上用户数据 |

`hatch.web_search` 永远是必需的 Hatch 内建 capability。Creator 自定义工具使用 `creator.*` 前缀；HTTP/MCP 仅引用由 Hatch Control Plane 管理的 `connection_ref`。本地电脑能力使用 `hatch.local.*` 声明需求，但由 Desktop Harness 决定是否实际提供。

## RAG 隔离

Corpus 不携带 `vector_store_id`。Registry 用 `agent.tenant_id + agent.id` 作为唯一 namespace：发布时为该 Corpus 的 `knowledge/` 建立独立索引；Runtime 只挂载当前 Agent 的索引。这样 RAG 可以在任何兼容存储后端上运行，且不同 tenant / agent 不会共享检索空间。

## 文档、工具定义与认证：三个独立平面

所有 `*.md`、`SKILL.md`、提纯后的知识文档及 `evals/cases.json` 都属于同一份 **Agent Corpus artifact package**。它们随 Corpus 存在 Registry 的 artifact storage 中；它们不是数据库字段，也不是 authentication 数据。

| 平面 | 保存什么 | 保存在哪里 | 绝不保存什么 |
|---|---|---|---|
| Agent Corpus | `agent.json`、system prompt、SKILL.md、clean RAG、Eval | Registry 的 Corpus artifact storage | 原始资料、token、URL、线上 trace |
| RAG index | 当前 Corpus `knowledge/` 的索引和 metadata | tenant + agent 隔离的 vector storage | 认证信息、其他 Agent 文档 |
| Tool Control Plane | connection metadata、Agent-to-connection binding、secret reference | Control Plane database + Secret Manager | 明文 secret、课程/RAG 内容 |

Corpus 只为每个 Creator HTTP/MCP 工具声明一个 `connection_ref`。Control Plane 维护最小关系模型：

```text
tool_connections
  id, tenant_id, kind(http|mcp), secret_ref, non_secret_config, status

agent_tool_bindings
  tenant_id, agent_id, tool_id, connection_id

user_tool_authorizations                  # 仅当工具需要最终用户 OAuth
  tenant_id, agent_id, end_user_id, connection_id, secret_ref, status
```

`secret_ref` 指向 Hatch 的 Secret Manager / KMS。关系数据库只能保存该引用和非机密 metadata，不能保存 API key、OAuth refresh token 或 MCP bearer token 的明文。Runtime 在一次 tool call 时按 `(tenant_id, agent_id, tool_id)` 查询 binding，在内存中短暂解析 secret，调用后丢弃。

每个 Agent 都有自己明确的一套 tool bindings；同一 tenant 内确实需要共用的连接可以绑定到多个 Agent，不复制同一把 key。Hatch `web_search` 是全局 Runtime capability，不进入任何 Creator 的密钥集合；`hatch.local.*` 由用户 Desktop 本地执行，也没有服务器密钥。

## Runtime 的职责

Runtime 读取一个已验证的 Corpus 后，才在自己的边界内：选择当前的 Kimi 2.6 provider、建立 delta streaming、把 RAG 文档索引成可检索空间、合并 Hatch 内建工具与 Corpus 声明的 Creator 工具、解析 HTTP/MCP connection refs、执行本地工具审批和记录 trace。Corpus 不反向依赖这些实现细节。

机器可读的权威定义为 [`agent-corpus.schema.json`](./schemas/agent-corpus.schema.json)。
