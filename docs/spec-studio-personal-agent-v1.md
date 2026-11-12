# Studio 个人助理 v1

状态：草案（2026-11-02）。由产品访谈倒推得到；尚未实现。

一句话：Studio 不再是"建 Agent 的分步流程"，而是每个专家一个一直在的助理。专家轻轻说一句意图，助理判断是哪个 Agent 的哪个环节，在后台执行，只在需要专家时出现。

## 1. 产品决定

| # | 决定 |
|---|---|
| P1 | 一个账户一个助理。它管这个人所有的 Agent。专家不选"我在改哪个 Agent"，助理判断是哪个 Agent 的哪个环节；专家不需要知道细节。 |
| P2 | 助理界面只有两样东西：一个对话，一个"需要你"列表（等你回答 / 等你审核 / 卡住了）。它是 Studio 的新入口；Studio 现有 UI 全部保留，原功能不受影响。 |
| P3 | 助理做五件事：① 补访谈（发现缺口就来问）② 把访谈变成内容 ③ 派 build worker 构建，并评测 ④ 管理产品发布（通过产品现有的 `/live`、`/withdraw`、`/pricing`、`/brief-spec` 接口） ⑤ 日常"戳一戳"，为了补充或发散。其他事直接说"这个我还做不了"，不假装能做，不静默降级。 |
| P4 | 派活前不确认。只有对外可见的变化要专家确认：发布或下架、内容定稿、改名字 / 承诺 / 价格 / 开场问题。发布是助理的工具（产品现有接口），构建是 build worker 的活：构建不需要确认，发布前确认。评测跑的是已上线版本，所以发布之后才能评测。补访谈问题只给专家本人看，直接做。 |
| P4a | 助理说话简短、直击要点、有情绪价值：先接住专家（认可、好奇），再说一件事。不写报告，不列清单，不说术语。 |
| P5 | 主动性从第一天就是真的：助理主动戳一戳、主动补访谈，不设"只记录"模式，也没有开关。克制靠频率规则和说话方式，不靠关掉。 |
| P6 | 入口：Studio 网页 + Telegram，同一个助理、同一段对话。LINE、WhatsApp 以后作为新的 Source 接入，不改模型。 |
| P7 | 助理不实现 voice。专家在 Telegram 和 Studio 发来的文档（txt、md、docx、pptx、xlsx、pdf）作为他的资料收下；语音和图片回复暂不支持。现有 Studio 的访谈不动。 |
| P7a | 先要资料，再开口：第一句话只要一样东西（名字、链接或现成资料）。资料只有两种来源：专家传的、公共互联网搜到的。搜到后先用"是这位……吗"确认身份，确认后在后台阅读，不让专家等，同时建草稿 Agent 并开始访谈。资料里有的绝不再问，最值得问的是资料和本人之间的落差。网上没有就由访谈从他最近一件真实的事开始。助理不做访谈：关于专家经历和判断的问题都交给访谈，访谈先列大纲（存在访谈会话的 todo 里），告诉专家要聊什么，聊完才交回。助理看着大纲进度决定下一步：没聊完就接着派访谈，聊完就更新 Agent 或写内容。负面内容不主动提，不写进公开内容，除非他自己提起。告诉专家看过哪些来源，他可以说"这篇不算数"。 |
| P8 | 所有 LLM 角色统一用 kimi-k2.6。 |
| P9 | 三代 factory 只保留 Factory Agents workbench。旧 CreatorFactory 引擎与 Factory Nodes 在本次改动中删除，前提是不影响现有 Studio UI（见第 6 节）。 |

原则（借自 DeepSeek `dsh-superagent` 的 000 Philosophy，不借它的实体）：**占用最少的注意力，给最多的价值。** 助理确认一次就安静做事；只在专家必须行动或能用上结果时说话；一次只问一个具体问题；如实报告失败。

## 2. 领域模型

只新增一个实体：**任务（Task）**。其余全部复用。

| 概念 | 落在哪里 | 新增？ |
|---|---|---|
| 助理 | 账户级的 workbench 会话，角色 `assistant` | 新角色，复用 `WorkbenchRuntime` |
| Worker | workbench 角色：`research`、`voice`（访谈；名字不改，助理只用文字）、`generation`、`case-generation`、`evaluator`，加 `content`、`profile-research` | 两个新角色 |
| 任务 | `hatch_assistant_tasks` | **新表** |
| "需要你"列表 | 查 `status = 'needs_you'` 的任务 | 否 |
| 来源（Source） | port：Web、Telegram、消费者"找真人"、定时 | adapter |
| 渠道（Channel） | port：Web（SSE）、Telegram | adapter |
| Telegram 绑定 | `accounts.telegram_chat_id`、`accounts.timezone` | 两列 |

不引入的 DSH 概念：Mandate、Policy、准入名单（能派活的只有账户本人，一行判断）；Thread、Subscription（对话本身就是 thread；后续消息靠任务 id 找到任务）；Correlation。

### 2.1 任务

```
hatch_assistant_tasks
  id, account_id, product_id (null = 不属于某个 Agent，如戳一戳)
  kind      interview | content | research | agent_research | build | evaluate | poke | change
  status    working | needs_you | done
  needs     answer | review | blocked        -- status = needs_you 时
  origin    jsonb   -- 来源与回复地址：{source, channel, message_ref}
  session   jsonb   -- 执行它的 workbench 会话：{role, session_id}
  output_ref text   -- 一篇内容 / 一次 release
  summary   text    -- 给专家看的一句话
  lease_owner, lease_token, lease_expires_at, attempts, next_attempt_at, last_error
  created_at, updated_at
```

- 租约、心跳、指数退避照抄 `creatorLearning/worker.ts:30-56` 的写法；旧 worker 删除后这段逻辑移到任务执行器。
- 服务重启：`working` 且租约过期的任务被重新领取，对应会话带一条恢复说明重跑（现在 workbench 重启只标 `interrupted` 不重跑，`factoryAgents/store.ts` `recover`）。

## 3. 架构

```
Source                     助理（每账户一个）              Worker（workbench 会话）
Web 对话 ──┐                                          ┌─> interview     补访谈
Telegram ──┤──> 代码过滤 ──> 判断 Agent + 环节 ────────┼─> content       写内容
找真人 ────┤   （是本人吗、     建任务、派活            ├─> generation → case-generation → evaluator   rebuild
定时 ──────┘    重复吗）         ▲
                                 └──── 完成 / 卡住 / 要问你 ────┘
                                              │
                                Channel：回到原对话（Web 或 Telegram）
                                需要人的，任务进 needs_you
```

### 3.1 助理

- 账户级 workbench 会话，存放于 `agent-chats/<accountId>/_assistant/`，复用 `WorkbenchRuntime`、SSE、todo。
- 只协调，不干活：可以用 `web_search` 快速查事实，但不写文件，深入阅读也派出去。所有 worker 都通过同一个 `start_task` 派出，新增 worker 只在 `AssistantService.workers` 加一条。工具：
  - `list_agents`：专家的 Agent、状态、上线链接。
  - `create_agent(name, promise)`、`update_agent(...)`：调用现有 `POST/PATCH /v1/creator/products`、`PUT …/pricing`、`PUT …/brief-spec`。
  - `dispatch(kind, product_id, instruction)`：建任务，向对应角色会话发一条消息（等同现在的 Start / Improve with latest，`FactoryAgents.jsx:175, 216-223`）。
  - `ask(task_id, question)`、`request_review(task_id, summary, actions)`：任务进 `needs_you`。
- 提示词：`runtime-server/prompts/factory-agents/assistant/SYSTEM.md`，写明 P4a 的说话方式。

### 3.1a 打断（steering）

助理像 coding agent 一样被 steer：所有来源先写入会话里持久的 ingress（`assistantDesk.ingress`）。正在运行时用 `agent.steer()` 注入当前这一轮，不中止，不丢上下文；没有运行时等一个很短的安静窗口再开始。一轮只对外发最后的回复。确认进入上下文后才从 ingress 移除，所以是至少一次。Telegram 按 `update_id` 去重。

### 3.1b 存储

助理工作区（助理、写内容、公开资料）的会话和文件存 Postgres（`hatch_workbench_sessions`、`hatch_workbench_files`），通过 `WorkbenchBackend` port 接入。产品工作区仍用磁盘文件。

### 3.1c 资料

资料存在助理会话的 `input/materials/`，派活时复制到对应 Agent 的 `input/manual/`，写内容和读公开资料的 worker 也会拿到一份。

### 3.1f 消息渠道

Telegram、LINE、Lark、iMessage 都实现同一个 `ChannelAdapter` port，助理不感知平台。Telegram 和 LINE 用我们的官方账号，iMessage 用 Photon 托管的线路，Lark 由专家自带应用（凭据加密存储），因为自建应用只在一个企业内可用。绑定统一用 15 分钟有效的一次性连接码，存在 `hatch_connections`（`hatch_assistant_channels` 已在启动时一次性迁入，不再读取）。回复回到消息来源的平台；主动消息发到专家最近活跃的平台。WhatsApp 暂不接：Meta 条款 §4.7 禁止以通用 AI 助手为主要功能的产品使用其平台。

### 3.1e 消息来源与当前状态

历史里的 user 消息带结构化的 `origin`：`expert` 或 `system`。任务通知和日常检查留在历史里给模型看，消息接口只返回专家和助理说的话，不靠匹配文本区分。当前状态（事项、在线情况、大纲进度）在每次调模型时临时加在末尾，不写入历史，也不给前端。

### 3.1d 图片

图片是模型原生输入，不转文字。浏览器端压缩（长边 2048 px，JPEG），Telegram 取已压缩的最大尺寸。文件存在会话的 `input/images/`，历史里只存引用，调模型时才读成字节，最近 4 张发像素，更早的只留路径。

### 3.2 访谈直通

派访谈是 handoff，不是后台任务：`start_task` 派访谈后助理这一轮随即结束，访谈接管对话，聊完才交回。这期间后台任务的消息留在 ingress，交回后再给助理。不在代码里过滤任何 agent 说的话。

补访谈时，专家只面对一个声音，但助理不在环中转话：

- `interview` 是普通 worker：被助理派活时只在 Product 的 `voice` 会话上写访谈大纲（todo）并报告，不接管对话；助理自己在对话里问专家，用 `tick_outline` 勾掉聊完的项。专家直接进 Studio 和 `voice` 聊，行为不变。
- 大纲写好，任务 `done`；Scribe 照常更新 `CREATOR_PERSONA.md`。
- 补访谈的问题来源：评测结果、消费者对话里 Agent 答不好的问题、专家新说的话。

### 3.3 五件事

| 事 | 执行 | 何时需要专家 |
|---|---|---|
| 补访谈 | `voice` 角色（找缺口 → 1 到 3 个问题 → 直通访谈） | 回答问题 |
| 写内容 | 新角色 `content`：只用访谈原话排序、删减，不编造 | 定稿（review） |
| 构建 | 现有 `generation`（Agent Builder）。助理派的构建拿不到 `corpus_upload`，只构建不发布 | 不需要 |
| 评测 | 现有 `case-generation` → `evaluator`，测的是线上版本 | 评测需要校准时（answer） |
| 读公开资料 | 新角色 `profile-research`，身份确认后在后台运行 | 不需要；读完助理把发现接进对话 |
| 产品发布 | 不是 worker：助理通过 `propose_change` 调用产品的发布接口，`list_agents` 读在线状态和待发布改动 | 发布、下架前（review） |
| 戳一戳 | 助理自己，由定时触发；不需要 worker | 回答（可不回） |

### 3.4 来源

- **Web**：Studio 对话。
- **Telegram**：见第 4 节。
- **定时**：runtime-server 内一个按分钟的 tick（目前没有任何 scheduler）。tick 自己不说话、不派活，只做两件事：
  - **到点叫醒助理**：每个账户每天一次，在其时区的白天，给助理投一条"日常检查"事件。助理读当天各 Agent 的消费者对话和评测结果，决定要不要补访谈、要不要戳一戳、问什么，也可以决定什么都不做。过滤在代码里：安静时段 22:00–08:00、每天至多一次主动开口、连续 3 次未回则降到每 3 天一次。
  - **接回断掉的任务**：租约过期的 `working` 任务重新领取（见 2.1）。

### 3.4a 结果怎么回到助理：事件驱动，不轮询

- Worker 干完由事件通知，助理不做饱和式检查。workbench 会话结束、失败、或调用 `askuser` 时已经发出事件（`factoryAgents/runtime.ts:188-210`）；任务执行器订阅这些事件，更新任务状态，再给助理投一条"任务 X 完成 / 卡住 / 要问专家"的消息。
- 助理只在三种时候被叫醒：专家说话、某个任务状态变了、tick 的日常检查。其他时间不运行。

### 3.5 渠道

- 回复写回任务的 `origin.channel`。
- 只在任务进入 `needs_you`、任务完成且有可用结果、或戳一戳时推送。工作中不推送进度。
- 长内容在 Telegram 只给摘要和 Studio 链接。

## 4. Telegram

- 一个官方 bot。绑定：Studio 点"连接 Telegram" → 生成签名一次性 token（复用 `registryAuth.ts` 的 HMAC token）→ `t.me/<bot>?start=<token>` → webhook 收到 `/start <token>` → 写 `accounts.telegram_chat_id`。
- Webhook：`POST /v1/telegram/webhook`，校验 `X-Telegram-Bot-Api-Secret-Token`。未绑定的 chat 只回一句"请从 Hatch 连接"。
- 确认用 inline keyboard，`callback_data` 带任务 id 与动作。回复某条消息时，用它找到对应任务。
- 文档：下载（Telegram 上限 20 MB）并转换后存入资料。语音和图片：回复暂不支持。
- 开发与 UAT 用独立的 bot（独立名字、独立 token），不得复用正式 bot。

## 5. 模型

- 所有角色（助理、全部 worker）用 `kimi-k2.6`：`HATCH_FACTORY_LLM_PROFILE=kimi-k2.6`，`compose.app.yml:49, 139` 改掉 `gemini-api`；`factoryAgents/runtime.ts:30`、`server.ts:21` 的默认值改为 `kimi-k2.6`。
- 实时语音对话（Gemini Live）已移除；访谈只用文字，听写（Qwen STT）保留。

## 6. 删除清单（FAST FORWARD）

原则：Studio 现有 UI 全部保留，原功能不受影响。只删除没有任何现有 UI 依赖的旧后端。

- **旧 CreatorFactory 引擎**：`creatorLearning/engine.ts`、`worker.ts`、`httpApi.ts` 的 factory-runs 路由、`creatorFactoryCli.ts`、`compose.app.yml` 的 `factory-worker` 服务、registry 的 `immediateFactoryWorker`、dashboard 对 `/v1/creator/factory-runs*` 的残留引用（`server.mjs:1541, 1619-1625`，dashboard 已对这些路由返回 404）。租约写法先搬到任务执行器。
- **Factory Nodes**：`nodeService.ts`、`nodeRegistry.ts`、`/nodes/(about-you|corpus)/executions` 路由（`registryServer.ts:746-830`）。**例外**：现有 candidate 审核页（`/studio/products/:id/candidates/:cid` → `CreatorProductWorkspace`）仍依赖它；实现前先确认这个页面是否还有真实入口，有则保留 Nodes 中它用到的部分。
- **孤立文件**：`CreatorFactoryRuns.jsx`、`CreatorReviewPage.jsx`、`CreatorProductOverview`，没有任何页面引用，删除不影响功能。
- 保留：Studio 全部现有页面、访谈、`CorpusPublisher`、`ProductLiveService`、`corpus_upload`、release/live 表。
- 旧表不再读写；删表另起一次明确的 migration。

## 7. 工作流

```
A 任务表 + 执行器 + 定时 ──┬──> C 助理角色 + 五件事 ──> E Studio 新入口（现有页面不动）
B 删除旧 factory 后端 ─────┘                    └──> D Telegram
```

A、B 可并行；C 依赖 A、B；D、E 依赖 C。

## 8. 验收

- 全部走真实链路：真实专家账户、真实 kimi-k2.6、真实 Telegram（开发 bot）、真实消费者对话、真实上线。
- 五件事各跑通一次真实闭环：
  1. 专家在 Telegram 说一句话，助理找对 Agent 和环节；
  2. 补访谈直通；
  3. 内容定稿；
  4. 构建后经确认发布，消费者端拿到新 release；
- 服务重启后，`working` 任务被接回并完成。
- 戳一戳遵守频率规则：安静时段不发、每天至多一次、连续 3 次未回后降频。
- Studio 现有页面（Overview、Agents、Build、Publish、Orders、Earnings、Settings、访谈）回归通过，行为不变。
- 区分 unit/component test、真实集成测试、真实 UAT；缺账号或依赖时标为未验收。