# Hatch Runtime Skills v1

状态：Proposed

## 1. 决策摘要

Hatch 的 Skill 采用 Codex/Agent Skills 最常见的 bundle 语义，并提供一个唯一、普通的 loader tool：`Skill(skill_name)`。

`Skill` 只负责把对应 Skill 的 `SKILL.md` 和 bundle resource manifest 加载到当前 Agent context。它不是 Agent、Task、sub-run，也不是第二套工具执行器。加载完成后，当前 Agent 继续使用普通的 file、shell、web、MCP 和 Creator tools。

在同一个 Creator authority 内，已加载 Skill 是当前 turn 的最高优先级 Creator instruction；它高于 Agent 的基础 Product instruction 和 Consumer request。Runtime 的平台契约、工具边界和取消语义仍然是外层 contract。

```text
session start
  -> put Skill name + description + locator in the Runtime system prompt
user request
  -> model selects a matching Skill
  -> Skill(skill_name)
  -> SKILL.md + bundle manifest enter the Creator-authoritative system prompt
  -> the ordinary Skill tool result remains in the current transcript
  -> model follows the Skill instructions
  -> ordinary tool calls
  -> final answer
```

这与 OpenAI 官方 API 中的两个事实一致：Skills 是可安装、可列出、可下载并具有 immutable versions 的 bundle；Responses 的 local/inline Skill 是输入环境的一部分。Hatch 在这个 bundle 模型上提供显式的 `Skill(skill_name)` loader，作为 Runtime 的普通 function tool。[OpenAI Skills API](https://developers.openai.com/api/reference/go/resources/skills) · [Responses Skill types](https://developers.openai.com/api/reference/ruby/resources/beta/subresources/responses)

## 2. 目标与非目标

### 目标

- 直接接受 Codex/Agent Skills 风格的 Skill bundle。
- 用廉价的 name + description catalog 做发现，按需读取正文和资源。
- 保持 Skill 与普通 Agent loop、普通 Tool、普通 Conversation 的一致性。
- 让一个 Skill 可以被多个 Agent/产品复用，但不复制第二套执行语义。
- 让 Runtime 的 capability、approval、workspace containment 继续是唯一的工具权限 authority。

### 非目标

- 不接入 OpenAI Skills REST API 作为 Hatch Runtime 的运行依赖；Hatch 只兼容其 bundle 语义。
- 不建立 `SkillRuntime`、headless worker、skill session 或 nested Agent。
- 不为 Skill 建立第二个 run identity、第二条事件流或第二套持久化 history。
- 不允许 Skill 通过 metadata 获得原本没有的工具、凭据、网络或 workspace 权限。
- 不把 Skill 做成整个 Agent 产品 workflow 的 giant prompt。

## 3. Skill bundle 格式

```text
<skill-name>/
├── SKILL.md                    # required
├── agents/openai.yaml          # optional UI / policy metadata
├── scripts/                    # optional executable helpers
├── references/                 # optional method / example material
└── assets/                     # optional output assets
```

### 3.1 `SKILL.md`

文件必须以 YAML frontmatter 开始：

```yaml
---
name: pdf-review
description: Review PDF files and produce a concise evidence-based report.
license: Apache-2.0
compatibility: Requires PDF extraction support.
metadata:
  short-description: Review PDF files
---

# PDF Review

Instructions loaded only when this Skill is selected.
```

规范要求：

- `name` 和 `description` 必填。
- `name` 使用小写字母、数字和单个连字符，且与父目录名称一致。
- `description` 只描述能力和触发条件，不写完整流程摘要。
- 正文是 Markdown instructions；正文不进入 startup catalog。
- `license`、`compatibility`、`metadata` 为可选兼容字段。
- 可接受 Codex 的 `allowed-tools` 字段，但它只能缩小当前会话允许的工具范围，不能授予新能力；没有该字段时不增加任何特殊权限。

### 3.2 `agents/openai.yaml`

该文件是 harness/UI metadata，不是 Skill instructions：

```yaml
interface:
  display_name: "PDF Review"
  short_description: "Review PDF files"
  default_prompt: "Use $pdf-review to review this PDF."

policy:
  allow_implicit_invocation: true

dependencies:
  tools:
    - type: mcp
      value: example-server
      description: Example MCP dependency
```

Hatch v1 读取并保留：

- `interface.display_name`
- `interface.short_description`
- `interface.icon_small`
- `interface.icon_large`
- `interface.brand_color`
- `interface.default_prompt`
- `policy.allow_implicit_invocation`
- `dependencies.tools`

依赖声明只用于发现、展示和配置检查；它不是隐式的 tool grant。

## 4. Discovery

Runtime 只从已授权的 server/product/Agent skill roots 发现 Skill：

- 当前 Agent/Registry 绑定的 published Corpus；
- Hatch 内置或 Creator 明确配置的 server skill root；
- `HATCH_SKILL_ROOTS` 或 runtime package 显式传入的 root。

Runtime 不默认扫描用户 workspace、任意 `.codex/skills`、任意 `$CODEX_HOME` 或宿主机其他目录。若要使用用户本地 Skill，必须由 Desktop/Workspace capability 明确授权并传入受 containment 保护的 root。

发现阶段只读取：

- `SKILL.md` frontmatter；
- `agents/openai.yaml` metadata；
- Skill 的稳定 resource locator。

发现阶段不得读取或注入完整 Skill 正文、references、scripts 或 assets。

无效 Skill 不进入 catalog，并记录可诊断的 load error。无效 Skill 不得通过 fallback、mock 或静默修复进入产品运行时。

## 5. Catalog 与 progressive disclosure

每个 session 的 catalog entry 最小为：

```json
{
  "id": "pdf-review",
  "name": "pdf-review",
  "description": "Review PDF files and produce a concise evidence-based report.",
  "locator": "skill://pdf-review/SKILL.md"
}
```

Catalog 可以附加 `short_description` 和 UI metadata，但不得包含 Skill 正文。

Skill 默认允许 implicit invocation。用户明确提及 `$pdf-review` 或 linked Skill mention 时，必须优先选择该 Skill。`allow_implicit_invocation: false` 时，只能由显式 mention 选择。

Skill discovery/selection 由 catalog 和模型判断完成；真正的加载必须通过唯一的 `Skill` function tool 完成。

## 6. Loading 与执行

### 6.1 `Skill` loader tool

Skill 选择后，模型调用唯一的 Skill loader：

```json
{
  "name": "Skill",
  "arguments": {
    "skill_name": "pdf-review"
  }
}
```

`Skill` 的 canonical schema：

```json
{
  "type": "function",
  "name": "Skill",
  "description": "Load a Skill's SKILL.md and bundle into the current Agent context.",
  "parameters": {
    "type": "object",
    "properties": {
      "skill_name": { "type": "string", "minLength": 1 }
    },
    "required": ["skill_name"],
    "additionalProperties": false
  }
}
```

Runtime 解析 catalog 中的 `skill_name`，验证已授权 root、Skill version/digest 和 bundle containment，然后返回：

```json
{
  "skill_name": "pdf-review",
  "skill_id": "pdf-review",
  "instructions": "<complete SKILL.md markdown body>",
  "bundle": {
    "locator": "skill://pdf-review/",
    "resources": [
      { "path": "references/method.md", "kind": "file", "digest": "sha256:..." },
      { "path": "scripts/check.py", "kind": "file", "digest": "sha256:..." }
    ]
  }
}
```

`instructions` 是完整 `SKILL.md` 正文；`bundle.resources` 是 bundle 的可用资源清单。加载成功后，Runtime 将该正文和 manifest 追加到当前 Agent 的 Creator-authoritative system prompt，并保留普通 tool result 作为当前 transcript 的可审计加载记录。文本、脚本和二进制 asset 的 bytes 不要求在第一次 `Skill` 调用中全部内联，后续按 Skill 正文需要通过普通资源/工具读取。一次 session 内重复调用同一个 Skill 必须幂等，不得启动第二个 Agent 或第二条 run。

`Skill` 调用使用普通 `tool_call.delta` 生命周期，但它是一个独立的 canonical tool name；它不等价于 `file_read`，也不允许模型绕过 `Skill` 直接读取未激活的 `SKILL.md`。

### 6.2 资源读取

当 `SKILL.md` 引用资源时，模型只读取当前任务需要的、已经由 `Skill` 激活的资源：

- `references/`：使用普通 `file_read`；
- `scripts/`：使用普通 `shell_exec`，脚本路径相对 Skill 目录解析；
- `assets/`：使用普通 `file_read` 或输出工具。

所有相对路径必须相对于当前 Skill 目录解析。路径 containment、symlink 解析、文件大小、编码和超时限制由 Runtime/Runner 的普通资源与工具边界负责。

### 6.3 Agent loop

`Skill` 返回正文和 bundle 后，继续使用当前 Agent 的 conversation、system boundary、tool list、approval 和 cancellation；Skill instructions 从下一次 provider request 起作为 Creator-authored system instructions 生效。Skill 不拥有独立的：

- Agent loop；
- conversation；
- run id；
- tool registry；
- approval policy；
- event stream；
- output contract。

Skill 只提供 instructions 和可选 resources。

## 7. Tool 与权限

除唯一的 `Skill` loader 外，Skill 不注册工具，也不改变工具名称。模型可见工具仍来自 Runtime 的 canonical tool registry。

Skill 可以声明 `allowed-tools` 作为兼容性提示或 restrictive hint，但必须满足：

1. Skill 不能授予 session 没有的 tool。
2. Skill 不能绕过 Desktop approval、native grant、workspace containment 或 server policy。
3. Skill 不能通过 `agents/openai.yaml` 的 `dependencies.tools` 自动创建连接或读取凭据。
4. 工具调用结果仍属于当前普通 conversation；不创建 protected worker transcript。

## 8. Conversation、UI 与持久化

Skill 加载是普通 `Skill` tool call。Desktop 可以从该普通 tool activity 推导“Skill loaded”展示，但 v1 不新增 Skill 专属 event type。

Runtime 新写入的事件和持久化记录不得包含：

- `skill.run`；
- `skill.session`；
- `skill_run_id`；
- `scope: skill_run`；
- worker prompt 或 worker transcript。

历史版本已经存在的 Skill 专属记录，只能在 read-time migration boundary 被读取；不得继续双写或让旧的 Skill runtime 成为新数据的 authority。

## 9. Agent Corpus 集成

Published Corpus 中的：

```text
skills/<skill-id>/SKILL.md
skills/<skill-id>/references/*.md
```

使用与 server skill 完全相同的 discovery、catalog、loading 和 ordinary tool semantics。Corpus 只提供已绑定的 bundle root/digest；它不创建第二种“直接 materialize 到 prompt”的运行模式。

`instructions/system.md` 始终按 Agent 规则加载；Skill 正文只在被选择并读取后进入当前 Agent 的 Creator-authoritative system context；`knowledge/` 仍然是 retrieval-only；`evals/` 永不进入运行时 context。

## 10. 错误语义

| 情况 | 行为 |
|---|---|
| Skill frontmatter 无效 | 不进入 catalog，返回 discovery diagnostic |
| Skill 不存在或未授权 | 普通 `Skill` tool error：`skill_not_found` 或 `skill_not_authorized` |
| Skill digest 不匹配 | 普通 resource error：`skill_changed` |
| references/scripts 越界 | 普通 containment error，拒绝执行 |
| Skill 内容要求未授权工具 | 按普通 tool policy 拒绝，不产生 Skill 专属失败状态 |
| 模型选择多个 Skill | 逐个按需读取，仍在同一个 Agent loop |

## 11. Acceptance criteria

实现必须通过以下真实 Runtime contract tests：

1. 仅有合法 `SKILL.md` 的 bundle 可以被发现和加载。
2. 带 `agents/openai.yaml` 的 Codex/OpenAI-style bundle 可以被发现；metadata 不会被误当 instructions。
3. session startup 的 catalog 不包含 Skill 正文。
4. `$skill-name` 可以选择 `allow_implicit_invocation: false` 的 Skill。
5. 选择后调用 `Skill({"skill_name":"..."})`，返回完整 `SKILL.md` 正文和 bundle resource manifest。
6. `SKILL.md` 引用的 reference 使用普通 `file_read`，script 使用普通 `shell_exec`。
7. Skill tool calls 与普通 tool calls 使用同一套 approval、containment、cancel、event 和 persistence contract。
8. Model tool definitions 中存在唯一的 `Skill` loader tool，不存在 `skill_run` 或 `load_skill`。
9. 新的 wire/persistence event 中不存在 `skill.run`、`skill.session` 或 `scope: skill_run`。
10. Agent Corpus Skill 与 server Skill 走同一套 runtime path。
11. Skill 不可通过 metadata 获得未声明或未授权的工具和凭据。

## 12. 从当前实现迁移

以下是直接切换，不保留新旧双写：

- 从 model tool registry 移除 `skill_run` / `skill.run`，加入唯一的 `Skill` loader tool。
- 移除 `SkillRuntime`、`allowSkillRun`、`toolScope: skill_run` 和 worker transcript。
- 让 main Agent 通过 `Skill({skill_name})` 加载 server-owned `SKILL.md` 和 bundle manifest。
- 仅允许已经加载的 Skill 通过普通 resource/tool path 读取其 references、scripts 和 assets。
- 保留并复用当前 `SKILL.md` parser、catalog、progressive-disclosure budget 和 `agents/openai.yaml` parser。
- 将 `allowed-tools` 降级为 ordinary tool-policy 的 restrictive hint，禁止 capability escalation。
- 删除 `skill.run` / `skill.session` wire schema、store writes 与 read-time migration；cutover 后不再读取或投影旧 Skill 事件。
- 将现有 SkillRuntime tests 改为 `Skill({skill_name})` + ordinary tool loop contract tests。
- 更新 Runtime README、Agent Corpus 文档和 Desktop activity projection，统一使用 ordinary tool semantics。

## 13. 一句话判断标准

如果 `Skill(skill_name)` 只做一件事——加载对应的 `SKILL.md` 和 bundle——然后当前 Agent 继续使用同一套 loop 和 Tool contract，那么这个 Skill 设计就是普通的；如果需要另一个 runtime、另一个 run 或另一条事件流，说明又做复杂了。
