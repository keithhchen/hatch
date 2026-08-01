# 创作者如何接入 Hatch

Hatch 帮助创作者把自己的方法、判断和工作流做成一个可安装的 AI App。

你不需要自己开发聊天客户端、桌面应用或本地文件工具。你提供 AI 方法和必要的服务端能力，Hatch 负责把它变成用户可以直接使用的产品。

## 一句话流程

```text
创作者提供方法
  -> 按 Agent Skills 约定打包 Skill
  -> 声明 App 信息和工具能力
  -> 接入自己的服务端 API（如需要）
  -> 在 Hatch 中测试、审核、发布
  -> 用户安装后直接聊天使用
```

## 三种核心接入能力

Hatch 为创作者提供三层能力。它们可以单独使用，也可以组合成一个完整的 AI App。

### 1. System Prompt：定义 App 的身份和总规则

System Prompt 适合放置 App 的稳定基础规则，例如：

- App 的身份、目标和语气；
- 总体任务边界；
- 回复语言和基本格式；
- 全局安全规则；
- 不应执行的请求；
- 何时调用 Skill 或 HTTP 能力。

它是 App 级别的长期配置，会参与每次会话的运行。System Prompt 不应放用户个人数据、短期任务内容或需要频繁更新的知识。

对外可见的 App 介绍可以说明行为和边界，但完整 System Prompt 属于创作者的运行时配置，不会作为客户端资源分发。

适合这样理解：

```text
System Prompt = 这个 App 总体上是谁，以及始终遵守什么规则
```

### 2. Skill：封装可复用的专业方法

Skill 适合放置一套完整的方法论或工作流，例如合同审查、内容策划、求职材料评估或研究流程。

Skill 可以包含：

- 判断步骤和决策标准；
- 领域知识和参考资料；
- 工具使用顺序；
- 质量检查清单；
- 特定任务的输出要求；
- 需要人工复核的边界。

Skill 遵循 Agent Skills 的 `SKILL.md` 目录约定。App 可以拥有多个 Skill，运行时根据用户的自然语言任务选择合适的 Skill，用户不需要手动输入 Skill ID。

Skill 与 System Prompt 的区别是：

```text
System Prompt = App 的全局身份和总规则
Skill         = 某一类任务的专业执行方法
```

创作者可以把核心方法保留在服务端受保护的 Skill runtime 中。用户能看到 App 的公开描述、运行状态、工具活动和最终结果，但不会获得完整 `SKILL.md`、内部提示词或 worker 原始过程。

### 3. HTTP：连接创作者自己的服务和数据

HTTP 适合接入需要在服务端运行的能力，例如：

- 创作者自己的业务 API；
- CRM、知识库或数据库；
- 搜索、计算和内容处理服务；
- 第三方平台集成；
- 私有文档的检索服务。

创作者提供 HTTP endpoint、请求/响应约定和认证方式，Hatch 在服务端通过 adaptor 将它接入 Agent。API secret 保存在服务端，不进入客户端、公开 manifest 或用户 workspace。

适合这样理解：

```text
HTTP = App 如何连接创作者控制的外部服务
```

如果数据来自用户文件，可以使用本地 workspace 工具；如果数据属于创作者服务或需要集中检索，则通过 HTTP/API 接入。两者可以在同一个任务中组合。

### 三者如何组合

一个合同审查 App 可以这样设计：

```text
System Prompt
  规定 App 是“客户方合同审查助手”，不提供正式法律意见

Skill
  规定如何读取合同、识别风险、排序问题、提出 fallback position

HTTP
  连接创作者维护的条款库、监管资料或公司政策数据库
```

用户只需要在聊天中提出任务。Hatch 会在服务端运行 System Prompt 和 Skill，并在需要时调用 HTTP；涉及用户本地合同的部分，则通过 Desktop workspace 工具读取。

### 能力边界对照

| 能力 | 最适合放什么 | 运行位置 | 用户能看到什么 |
| --- | --- | --- | --- |
| System Prompt | App 身份、全局规则、总边界 | 创作者服务端 runtime | App 的公开行为说明和最终回答 |
| Skill | 专业方法、工作流、判断标准 | 服务端 protected Skill runtime | Skill 名称、状态、工具活动和结果 |
| HTTP | API、数据库、私有服务和外部数据 | Hatch 服务端 adaptor | 服务调用状态和最终结果，不含 secret |

一个原则是：不要把需要保护的专业方法塞进公开 manifest，也不要把 API secret 或完整内部 prompt 放进 Skill 包、客户端代码或用户文件。

## 你需要提供什么

### 1. 一个清晰的 AI 方法

先定义你的 App 帮用户完成什么结果，而不是先写 prompt。

建议说明：

- 目标用户是谁；
- 用户通常会提供什么上下文；
- App 要完成的任务和步骤；
- 什么情况下应该读取、修改或生成本地文件；
- 什么情况下必须询问用户或停止；
- 最终结果应该是什么样子。

例如：

```text
帮助创业者审查供应商合同，读取用户本地合同，按风险优先级给出谈判建议，
并明确哪些结论需要律师复核。不得把结果表述为正式法律意见。
```

### 2. 一个符合 Agent Skills 约定的 Skill 包

Skill 的入口文件是 `SKILL.md`。Skill 可以带可选的参考资料、脚本和资源：

```text
my-contract-review/
  SKILL.md
  references/       # 可选：详细参考资料
  scripts/          # 可选：可复用脚本
  assets/           # 可选：模板或其他资源
```

最小的 `SKILL.md` 示例：

```md
---
name: contract-review
description: Review commercial contracts and prepare prioritized negotiation notes.
---

# Contract Review

Describe the review method, decision criteria, useful examples, and boundaries.
Keep instructions focused on the creator's method rather than the Hatch client.
```

`SKILL.md` 的完整内容属于创作者资产。Hatch 会在服务端运行它，用户客户端只看到 App 的公开信息、工具活动和最终结果，不会下载 Skill 原文或内部工作提示。

### 3. App 的公开信息

每个 App 需要一组用户可理解的公开信息：

- App 名称和一句话描述；
- 适用人群和典型任务；
- 创作者身份；
- 当前版本；
- 需要的能力，例如本地读取、写入、运行命令或服务端 API；
- 数据处理说明和使用边界。

公开信息用于 App 列表、安装和运行前的说明。不要把私有方法、内部评分标准或 API secret 放进公开 manifest。

## 工具和数据怎么接入

Hatch 将工具分成两类。你只需要声明 App 需要什么能力，Hatch 负责执行和连接。

### 用户本地工具

适用于用户 workspace 中的文件和本地环境：

- 读取、列出和搜索本地文件；
- 写入 App 生成的文件；
- 执行必要的本地命令；
- 使用本地 workspace 的持久状态。

这些工具由 Hatch Desktop 的本地运行时执行。你的 Skill 通过工具请求使用它们，不需要直接访问用户电脑，也不需要设计自己的桌面插件。

### 创作者服务端 API

适用于你的业务 API、数据库、搜索服务或第三方集成：

- 由你提供 HTTP API 和请求/响应约定；
- API credential 只配置在服务端；
- Skill 通过 Hatch 的服务端 adaptor 调用 API；
- 客户端不会收到 API secret，也不会直接调用你的私有 API。

如果数据原本是文件，也可以由你在服务端提供检索或数据库访问层。需要上传或同步哪些数据，应在 App 的数据说明中明确告知用户。

## 用户使用时发生什么

用户安装 App 后，不需要记住 Skill ID，也不需要手动输入 `skill.run`。用户只需要用自然语言描述任务：

```text
请审查我 workspace 里的供应商合同，先读取合同，再按风险优先级给出 redline 建议。
```

Hatch 会：

1. 将用户消息发送到 App 的服务端运行时；
2. 根据 App 的公开能力和任务选择合适的 Skill；
3. 在服务端加载并运行私有 Skill；
4. 如果需要本地信息，通过 Desktop 请求用户 workspace 工具；
5. 如果需要外部数据，通过服务端 API 或其他服务端工具处理；
6. 把运行进度、工具活动和最终回答显示在聊天界面。

Skill 是 App 的内部模块，不是用户需要显式调用的命令。

## 接入步骤

### 第一步：提交创作者资料

提供创作者身份、App 简介、目标用户、典型使用场景，以及你希望保护的核心方法。

### 第二步：准备 Skill 包

按照 Agent Skills 的目录结构整理 `SKILL.md` 和可选资源。把方法写成可执行的工作流，至少覆盖：

- 任务识别；
- 信息收集顺序；
- 判断标准；
- 工具使用时机；
- 输出格式和质量要求；
- 安全边界与需要人工复核的情况。

### 第三步：声明能力

明确 App 是否需要：

- 读取本地 workspace；
- 写入文件；
- 执行本地命令；
- 调用创作者 API；
- 访问其他服务端数据源。

能力声明应遵循最小必要原则。Hatch 会在运行时记录工具请求、结果和状态，便于排查问题和复核行为。

### 第四步：配置服务端集成

如果 App 需要 API，提供：

- API endpoint；
- authentication 方式；
- 请求参数和响应格式；
- 超时、限流和错误约定；
- 测试环境或测试账号；
- 数据保留和删除规则。

Hatch 的运行时 adaptor 负责把服务端能力接入 Agent。不要把 secret 写进 `SKILL.md`、manifest、客户端代码或用户 workspace。

### 第五步：测试和审核

至少准备以下验收案例：

- 一个正常的端到端任务；
- 缺少本地文件时的行为；
- 工具返回错误或超时时的行为；
- 用户取消任务时的行为；
- 不应执行的请求；
- 包含敏感信息的输入；
- App 重启或聊天恢复后的行为。

审核重点包括：方法质量、工具使用是否合理、输出是否误导用户、隐私说明是否完整，以及 Skill 是否试图获取不必要的权限。

### 第六步：发布新版本

审核通过后，Hatch 为 App 生成版本记录和发布元数据。之后用户可以从 Hatch 安装、更新和使用 App。Skill 的私有内容留在创作者运行时，平台分发的是公开 App 信息和安装所需的签名元数据。

## 创作者负责什么，Hatch 负责什么

| 创作者负责 | Hatch 负责 |
| --- | --- |
| AI 方法、判断标准和内容质量 | Desktop Chat 和 App 使用体验 |
| `SKILL.md` 及私有参考资料 | 服务端 Agent runtime 和 Skill worker |
| 自有 API 的产品和稳定性 | 本地 workspace 工具桥接 |
| 数据来源、保留和删除规则 | 运行事件、工具状态和会话恢复 |
| App 的公开说明和合规边界 | 安装、版本、分发和审核流程 |
| 运行成本和服务端模型配置 | 客户端不接触 creator secret |

## 不需要自己做什么

接入 Hatch 时，创作者不需要：

- 开发一个新的聊天客户端；
- 开发 Tauri、文件系统或 shell 执行器；
- 让用户配置模型 API key；
- 把私有 Skill 发给用户；
- 自己实现客户端工具协议；
- 要求用户输入 Skill ID 或手动调用 Skill；
- 把用户全部 workspace 上传到平台。

## 上线前检查清单

- [ ] App 的目标结果可以用一句话说明。
- [ ] `SKILL.md` 使用标准 Agent Skills 目录结构。
- [ ] 私有方法和内部提示没有出现在公开 manifest。
- [ ] 所有工具能力都已声明，并且确实被任务需要。
- [ ] API secret 只存在于服务端配置。
- [ ] 本地文件路径按 workspace 规则处理，不要求用户粘贴私有内容。
- [ ] 正常、失败、取消和恢复场景都有测试。
- [ ] 用户能理解 App 会读取或修改什么数据。
- [ ] 需要律师、医生或其他专业人士复核的结果已明确提示。
- [ ] App 的版本、更新和数据处理说明已准备好。

## 当前接入状态

Hatch 当前的 creator integration 以受控 MVP 为主：核心运行时、受保护 Skill、Desktop 本地工具桥接、公开 manifest 和注册表流程已经定义，正式的创作者控制台、审核、计费和生产级发布流程仍需按产品阶段开放。

如果你准备接入一个具体的 AI App，请先准备：App 简介、`SKILL.md`、能力清单、API 说明（如有）和端到端测试案例。Hatch 会据此完成运行时配置、测试和发布审核。
