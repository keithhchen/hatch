# 统一账户与原生 Desktop v1

状态：草案（2026-10-26）。由产品访谈倒推得到；尚未实现。

## 1. 产品决定

| # | 决定 |
|---|---|
| P1 | 数据层只有一种用户。任何人都能进 Studio 创建、上架 Agent，也能获取别人的 Agent。没有"专家旅程 / 买家旅程"。Expert 依然是品牌叙事。 |
| P2 | `accounts.role` 作为历史字段留在库里，不再被读写，不再参与任何决策。 |
| P3 | 所有者无需获取即可与自己**已发布**的 Agent 聊天。草稿聊天是二期新能力。 |
| P4 | 不能获取自己的 Agent。用户之间无特殊待遇（专家获取别人的 Agent 就是普通客户）。 |
| P5 | 一个注册流程，不选身份。早期双账号先不合并。 |
| P6 | 暂时全部免费。 |
| P7 | 登录后进入 Web 首页：空状态为"试试别人的 Agent / 做一个自己的"两张卡；有内容后为 继续 → 我的 Agent → 发现。 |
| P8 | Desktop 只做聊天。整个 Desktop UI 按新视觉系统重写；Chat UI 与 Web 完全复用（抽象复用，不复制）。技术栈仍为 React + Tauri。 |
| P9 | Desktop 必须有原生感：无白屏、无网页式加载动画、原生滚动/拖拽/右键菜单、字体清晰、窗口缩放与侧栏动画顺滑，**结构**也要符合平台惯例。 |
| P10 | 直接发新版 Desktop，不兼容旧版。 |

## 2. 工作流与依赖

```
A 身份统一（后端） ──┬──> B Web：首页 + 去 role
                    └──> D Desktop 重写 <── C packages/chat 抽取
```

A、C 可并行；B 依赖 A；D 依赖 A、C。二期：草稿聊天（私有 preview release）。

**导航原则（Web 与 Desktop 一致）：先选 Agent，再选该 Agent 的对话。** 任何地方都不混排不同 Agent 的对话。

## 3. A — 身份统一（后端）

**原则：** 访问是关系，不是身份。`所有者 = release.creator_id === sub`；否则必须持有 entitlement。`creator_id` 字段名保留，作为"所有者"关系。

- **账户与 token**
  - `registryAuth.ts:115`：`role` 去掉 NOT NULL / CHECK；新账号不写。从 `Account`、`AccountPublic`、`accountPublic()`、HMAC token（`:370-385`）、`validateSignupCredentials`（`:412`）删除 role。
  - `authToken.ts:3-25`、`entitlements.ts:32-34,323-330`：claims / identity 不再要求 role。
  - `registryServer.ts:522-537`：signup 不读 role；`/v1/auth/me` 不返回 role。
- **Registry 授权**：`registryServer.ts:1226` `authenticate(..., role)` 去掉 role 参数；`/v1/creator/products*`（`:385…1004`）与 voice WS（`:302`）改为任意登录账户 + `productForCreator` 所有权校验（已存在）。
- **Runtime 访问**（`index.ts`）
  - `RuntimeReleaseAgentCorpusResolver` 增加 `resolveByProduct(productId)`，从 `/v1/runtime/products/{id}/release` 拿 `creator_id`（所有者由服务端得出，不信任 `hello.creator_id`）。
  - hello / REST（`:3148-3263`, `:3439-3480`）：`product_id` 且无 `entitlement_id` → 要求 `release.creator_id === sub`；否则 → entitlement 通道。
  - 逐轮复核（`:3328-3368`）：无 entitlement → `sub === binding.creatorId`；有 entitlement → 去掉 `role === "user"`，保留 user/creator/product 匹配。`assertEntitlementMatchesIdentity`（`:3318`）只校验 `user_id`。
  - `entitlements.ts:175,230,265`：不再对 creator 返回空。
  - 会话按 `(owner_account_id, creator_id, agent_id)` 存储，与 entitlement 无关——所有者通道端到端已可用，只被 role 拦住。
- **Agent 列表**：`CreatorRegistryReleaseStore` 新增"某账户的已发布产品"查询（`live JOIN releases WHERE creator_id=$1 AND status='published'`，不 join `a.role`）。产品访问投影 `/v1/user/product-access` 返回 `owned` + `acquired` 两类条目；owned 条目无 entitlement，以 `product_id` 访问。删除 `/v1/me/creator-agents` 中的合成 `creator:` entitlement id。`CreatorRegistry.listCurrent`（`status='live'`）疑似陈旧，确认后删除。
- **自购规则**：`ledger.js` `order.placed` 校验（`~:953`）强制 `buyer_id !== creator_id`；`service.js` `confirmCheckout`（`~:251`）、`createPayment`、`confirmCheckoutFromProviderEvent` 预检返回明确错误；dashboard 结账入口提前 409。
- **公开展示**：`creatorRegistryRelease.ts:185`、`getCreatorPublicByIds`（`registryAuth.ts:157,163`）、`attachCreatorAvatars`（`registryServer.ts:1320`）不再按 role 过滤；"创作者"= 至少有一个已发布产品的账户。

## 4. B — Web：首页与去 role

- **去 role**（`creator-dashboard`）：`server.mjs` 所有 `authenticate(..., "user"|"creator")` 去掉 role；删除 `${role}_only`（`:2763`）、`ROLE_CAPABILITIES`（`:2811`，改为所有权）、`optionalBuyer` 的 role 判断（`:2787`）、`creatorSignup`（`:880-892`）、`portalState.mjs:116` 的 role。前端删除 `RoleBoundary`、`WebChatRoleGate`、`webChatGate.jsx`、`isExpertSession`/`isExpertBlocked`/`ExpertAccountNotice`、`creatorIntent`、`studioOpsModel.js:104` 的 role 默认能力，以及"专家账号 / 客户账号"文案（`buyerI18n`、`creatorI18n`、`studioOpsCopy`、`authPagePresentation`）。
- **Web chat 访问**：`WebChatClient` 改为以 `product_id` 为访问键，由服务端判定所有者或获取者（hello 不能同时带两者，`protocol.ts:81`）。bridge 校验 `product_id`。
- **自己的产品**：Explore / 产品页对自己的产品显示"去聊天"而非"获取"（替代 `BuyerPortalV2.jsx:451` 的 `isOwnerCreator`）。Discover 过滤掉自己的产品。
- **首页**：新路由（替代登录后默认 `/library`，`BuyerPortalV2.jsx:602`）。
  - 空状态：两张卡（去逛逛 / 做一个自己的）。
  - 我的 Agent：`/v1/creator/products`（已发布 → 聊天；制作中 → Studio；末尾"新建"卡）。
  - 发现：`/v1/public/products` 去掉自己的。
- 落地页 Studio / 登录入口统一走注册 → 首页。

## 6. C — `packages/chat`（Web 与 Desktop 共用）

两端读的是同一个 Runtime conversation 模型（protocol 0.8），只是传输与宿主能力不同。按 ports & adapters 拆分：

- **Domain（纯函数）**
  - Timeline 模型：text、**thinking**（来自 Web）、tool/activity、**skill / skill_run**、status、approval、attachment。合并 `webChatTimeline.js` 与 Desktop `activity-ui.js`、`stream-projection.js`、`main.jsx:4357-4731`。
  - 快照/分页对账：以 Desktop 更严格的 `conversation-pagination.js`（journal 排空、history 桥接、活动 run）为准，替换 `webChatSnapshotReconciler.js`。
  - 事件处理：两端事件并集（`session.error`、skill 事件、`turn.state`、`session.compacted`）。
  - 文本揭示节奏（`text-reveal.js`）作为可选策略。
  - 创作者名称/头像解析：两端回退链的并集（`product-policy.js:11-66`、`WebChatPage.jsx:771`）。
- **Ports**
  - `ConversationTransport`：list / create / snapshot / history / events / send / cancel / assets / hello。
  - `AttachmentSource` / `AttachmentViewer`。
  - `ToolExecutor`：execute / cancel / requestApproval + `localTools`（仅 Desktop）。
  - `DraftStore`：待发送消息与恢复。
- **Adapters**
  - Web：cookie + dashboard 代理（`/v1/web-chat/*`），`BrowserImageAttachments`，无本地工具。
  - Desktop：bearer + 直连 Runtime，Tauri 原生附件 / 拖放 / 剪贴板，本地工具，多窗口所有权（`conversation-owner.js`）。
- **Presentation**：以 Web 新视觉为唯一标准的 `<ChatView>`（消息、thinking ticker、任务背景、创作者信息、composer、审批、附件）。窗口外框和导航由各端 shell 通过插槽注入。Desktop 不再依赖 `@assistant-ui/react`（它只是视图层，store 与 transport 本来就不依赖它）。
- Desktop `main.jsx` 中 5700 行的 `App()` 拆成：auth/session、transport adapter、native bridge、shell，以及共享 chat。

## 7. D — 原生 Desktop

### 7.1 手感（参考来源均为开源项目源码）

1. **无白屏**：窗口 `visible:false`；React 首帧（两次 rAF）后 `invoke("app_ready")` → `show()`（Spacedrive、Clash Verge）。窗口按保存的主题设 `backgroundColor`，并用 `initialization_script` 在 React 之前写入 `data-theme` / `color-scheme`。window-state 不包含 `StateFlags::VISIBLE`。
2. **加载**：指示器延迟约 200ms 出现（VS Code `ProgressBar`）；结构性加载用与真实布局同形的骨架屏；刷新时保留旧内容；不用整面板 spinner。启动时用保存的布局尺寸画骨架（VS Code splash）。
3. **滚动 / 拖拽 / 选择**：`html, body { overflow:hidden; overscroll-behavior:none }`，只有内部面板滚动；`:not(input,textarea) { user-select:none; cursor:default }`，消息正文通过 `.selectable` 开启选择（Yaak、GitHub Desktop）；`img { -webkit-user-drag:none }`；`acceptFirstMouse`；`allowLinkPreview:false`；缩放走 App 设置（Yaak）。Windows 使用 `scrollBarStyle:"fluentOverlay"`。
4. **字体清晰**：系统字体栈（含 `Segoe UI Variable`）；审计文字所在图层上的 `will-change` / `opacity` / `filter` / 小数 translate，动画结束即移除；Windows 上文字放在不透明背景上（mica 下 ClearType 会退化）；不使用小数缩放。
5. **右键菜单**：全部通过 `@tauri-apps/api/menu` 原生弹出，编辑类菜单用 `PredefinedMenuItem`，全局拦截 `contextmenu`（Spacedrive）。原生外观随 App 主题（`set_theme` / NSAppearance，Yaak）。
6. **缩放窗口与侧栏**：侧栏动画用 `transform` 而不是 `width`；面板加 `contain: layout paint`；消息列表虚拟化 + `content-visibility:auto`；resize 时不做逐帧 JS 量布局。macOS 侧栏 vibrancy（`windowEffects: sidebar`）；Windows 用 mica，避免 acrylic（官方说明其拖动/缩放卡顿）。
7. 预热一个隐藏窗口，让"新窗口打开会话"即时出现（Cherry Studio）。WebContent 进程崩溃自动恢复（Clash Verge）。

### 7.2 结构（参照 Apple HIG / Fluent 及 ChatGPT、Claude、Messages、Slack）

- **侧栏 = 按 Agent 分组的 source list**（产品决定：方案 B）：顶部是"新对话"与"搜索 ⌘K"（去掉品牌 logo）；每个 Agent（我的 + 获取的）一个分组，组下是该 Agent 的对话，各组**独立展开/收起**（不再是互斥手风琴），展开状态按窗口持久化；末尾"浏览更多 Agent…"打开 Web Explore。
- **工具栏**：窗口标题为会话名，副标题为 Agent · 创作者；新对话、搜索。连接状态改为小指示器 / 内容区横幅。macOS 删除复制菜单栏的"…"。
- **检查器：完全删除**（产品决定）。产物、工具活动、审批只在对话流内呈现；文件夹与权限只留在 composer。
- **审批**：侧栏行徽标 + Dock 徽标 + 后台会话系统通知。
- **登录**：独立的小尺寸固定欢迎窗口，只有"在浏览器中继续"；在系统浏览器完成登录后通过已有 `hatch://` deep link 回到 App，切换到主窗口。Desktop 内不再有邮箱密码表单与多步 journey。
- **状态页**：启动直接恢复 shell 并显示占位行；网络错误 = 内容区横幅 + 重试，保留侧栏；无 Agent = 内容区空状态 + "浏览 Agent"。删除"不支持的角色"页面（P1）。
- **设置**：⌘, 或侧栏底部账户菜单打开的**弹出面板**（主窗口上的模态面板，左侧分类：通用 / 账户 / 高级），退出登录移到这里；替换现在独立的 720×560 网页窗口。About 使用原生 About 面板，版本号运行时读取（现在硬编码在 `main.jsx:253`）。
- **视觉**：硅谷式高级审美（参照 Linear、Claude、Raycast、Arc）：克制的中性色与单一强调色、细边线代替阴影、紧凑的 13px 系统字号层级、8pt 网格、短而带缓动的动效。以 Web 新视觉系统（`@hatch/ui`）为基础，统一 token。
- **菜单栏补全**：Find ⌘F；搜索会话 ⌘K；Conversation 菜单（重命名、归档、在新窗口打开、上一个 / 下一个、Agent 1–9 ⌘1–9）；切换侧栏 ⌃⌘S；Window 菜单列出所有窗口；Help 菜单。
- **窄窗口**：macOS 自动隐藏面板，不加遮罩；Windows 保留 NavigationView Minimal 的覆盖行为。
- **Windows 标题栏**：二期再考虑把工具栏延伸进标题栏（需自绘标题栏按钮，且要保住 Snap Layouts）。

## 8. 验收层级

按 AGENTS.md：unit / component test、fixture 视觉检查、真实集成测试、真实 OS UAT 分开记录。原生手感与结构只在真实 Desktop 构建（正式 bundle、真实账户、真实 Runtime）上验收；发布遵守 Desktop release 规则（版本源一致、annotated tag、DMG 与 EXE）。

## 9. 待定问题

已决：草稿聊天二期；首页采用"空状态两张卡 + 继续 / 我的 Agent / 发现"；Desktop 只做聊天；检查器删除；设置为弹出面板；Desktop 登录走浏览器 + deep link；侧栏按 Agent 分组（B）。

暂缓：Windows 标题栏融合；早期双账号合并。

## 10. 修正（2026-10-26 本地 UAT 反馈）

本节取代上文与之冲突的内容（§7.2 侧栏、§6 Presentation"以 Web 为唯一标准"、§9 中"侧栏按 Agent 分组（B）"和"首页继续"）。

**教训：** Desktop 重写时没有先列出 Desktop 独有能力，也没有逐项对照旧版验收，导致大量能力被删。"以 Web 为准"只适用于视觉，不适用于能力。

### 10.1 Web 与 Desktop 统一的结构
- **先选产品，再进入对话。** 任何界面都只显示一个 Agent 的对话。
- **Web**：导航只有"探索"和"Studio"，探索页的主区是"发现"，右侧是"我的 Agent"；手机上用"发现 | 我的 Agent"切换。订单是 `/explore/orders` 子页面。**没有搜索。**
- **Desktop 两种窗口**（和 Web 的"我的 Agent → 聊天页"对应）：
  - **Library 窗口**：启动时打开，列出我的 Agent（自己发布的 + 获取的）和"浏览更多 Agent"。
  - **Chat 窗口**：从 Library 点一个 Agent 打开，一个 Agent 一个窗口；侧栏只列这个 Agent 的对话，"新对话"只开在它下面；再次点击同一个 Agent 时聚焦已有窗口。关掉所有 Chat 窗口后 Library 还在。
  - 打开 Agent 时回到上次停留的对话。
  - **去掉搜索**（⌘K 面板和菜单项）。

### 10.2 Desktop 必须保留或恢复的能力
| 能力 | 规则 |
|---|---|
| 文件夹 | **必须先选文件夹才能开始对话**，不允许不选文件夹的纯聊天。没选时新对话空状态就是选文件夹的引导；未选不能发送，输入内容保留在内存中。带任务背景的任务也要等文件夹选好 |
| 权限 | "更改前询问 / 允许更改"始终显示，并加回说明文字；按对话保存 |
| 审批 | 放回工具那一行里，允许 / 拒绝；处理完留下"已允许 / 未允许"；Dock 角标和后台通知保留 |
| Agent 产出的文件 | 右键：在 Finder 中显示、Quick Look、复制路径、复制输出（复用现有 `reveal_workspace_artifact` / `open_workspace_artifact`） |
| 对话里的附件 | 另存为、打开（复用 `save_local_attachment` / `open_local_attachment`） |
| 草稿 | **不需要草稿机制**：删除原生草稿存储和发送途中的崩溃恢复 |
| 重连 | 跟 Web 一致：自动重试 3 次，失败后**静默**，下一次发送时重新连接 |
| 运行状态 | 显示 `turn.state`（见 10.3） |

### 10.3 压缩状态（Web 与 Desktop 都做，放在 `@hatch/chat`）
- **中**：`turn.state` 为 `compacting` 时显示"正在整理对话…"。
- **后**：`session.compacted` 到达后在对话里留一条分隔线"对话已整理"。
- 不做"压缩前"提醒（Runtime 不报告上下文用量）。

### 10.4 跨端接力
沿用已有机制（07717344）：Web 和 Desktop 在 `client.hello` 和每条 `client.message` 里带上各自可用的 `local_tools`；Runtime 每一轮按这份列表决定工具，并重建系统提示中的工具说明。Web 固定为 `[]`。
Desktop 之前在没选文件夹时发送 `[]`，看起来和 Web 一样，所以接力时模型不知道已经有本地工具。10.2 的文件夹限制恢复后，Desktop 每一轮都带完整工具列表。**不新增 Runtime 概念。**

### 10.5 头像
- 头像 fallback 的橙黄渐变（`#f5b700 → #e08a3c`）从 Web 的 `webTheme.css` 移到共享品牌 token，Web 和 Desktop 共用。
- OSS 客户端打开 `secure: true`，新生成的头像地址为 `https://`。生产库中现有 `accounts.avatar_url` 的 `http://` 地址需一次性改为 `https://`（上线时单独确认）。不加"只允许 HTTPS"的 bucket policy。Desktop 的 WKWebView 会拦截明文 http 图片，这是专家头像不显示的原因。

### 10.6 验收
每一项在 Hatch Dev（`dev.hatch.devlocal`）连本地复刻环境逐项验证，并对照 Desktop 独有能力清单；视觉与原生手感只以真机为准。
