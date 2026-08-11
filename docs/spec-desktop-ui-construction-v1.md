# Hatch Desktop UI Construction Plan v1

- 状态：Implementation baseline（P0–P3 foundation 已落地；P4 跨平台验收进行中）
- 日期：2026-08-11
- 平台：macOS 与 Windows
- 架构决策：V1 采用 Tauri Hybrid

## 核心决策

Hatch V1 继续采用 Tauri Hybrid。产品目标不是画一个模仿 macOS 的网页，而是先建立真正的桌面行为模型，再把每项职责交给适合的 Native 或 WebView 层。

macOS 与 Windows 都是一等平台。V1 使用 Tauri 稳定支持的 Native surfaces。本计划不包含 AppKit 或 WinUI Native-shell 重构；如果未来出现新的、已验证的产品需求，再通过单独 ADR 讨论，不占用当前路线。

## 当前实现与验收证据

本 spec 已对应到专用 worktree `codex/desktop-ui-construction`。当前完成范围：

- P0：debug/ad-hoc/UAT session 只使用进程内 token；macOS 正式签名包进入受 Developer ID / Team ID 约束的 Keychain。Windows 的 Win32 Generic Credential Manager 与 PasswordVault 都不能提供同用户 full-trust 进程不可读的 app-only bearer-token 边界，当前明确 fail-closed，未来须另立 device-bound session backend；Rust 持有 Workspace/approval authority。
- P1：React `DesktopWindowShell`、regular/compact/minimal tier、split divider、native-like overlay、局部 table/code overflow 与 accessibility contract。macOS-only 的 Overlay titlebar 配置放在 `tauri.macos.conf.json`，基础配置保留 Windows 的系统 frame/caption buttons，不把 macOS chrome 泄漏到 Windows。
- P2：durable Conversation/Run repository、REST/WS idempotency、active-run exclusion、restart→`interrupted`，以及 Desktop Conversation Library 的 list/create/select/rename/archive 基础接线。每个 native window 现在保存自己的 Conversation、Workspace grant、permission、active-run projection、`composerDraft` 与 snapshot cursor；context 以 account id 绑定，换账号登录时不会恢复上一账号的 Conversation、workspace 投影或草稿；profile settings 只作为旧单窗口数据的迁移 fallback，workspace onboarding 的旧 `draft` 字段不再冒充 Composer draft。Profile preference writes 使用 Native field patch，不再让多个 renderer 以整份 JSON last-writer-wins 覆盖彼此的 account/window settings。V1 的恢复边界是 observer recovery（snapshot + cursor replay）；断开或 Runtime 重启会把未完成 Run 标为 `interrupted`，不自动 reclaim、重放 tool 或伪装成 `running`。
- P3：Tauri application/context menu、semantic command routing、focused-window new-conversation scaffold 与 window-scoped bridge。
- P3：Artifact 的 Quick Look/Open 已接入 grant-bound native bridge；macOS 在主 AppKit 线程显示系统 `QLPreviewPanel`（不可用时才回退到 `qlmanage` launcher），Windows 使用默认文件关联的 ShellExecute `open`，Unix fallback 使用 `xdg-open`。Reveal、Notifications/Dock attention 与独立 Settings/About auxiliary windows 也已接入受支持的窄 native bridge。
- 尚未宣称 P4 完成：Windows 真机、VoiceOver/Narrator、签名发布包、双屏/DPI/IME，以及 renderer/Run 层的 crash/reload attach-replay 仍需目标环境验收。Native dynamic conversation-window manifest 已通过正常退出和 preview 进程强制终止后的恢复测试，并支持单窗关闭清理；这不等同于正在执行 Run 的 crash recovery。

macOS UAT 证据：

- [Regular 1180×780](proof/desktop-ui/regular-1180x780.png)
- [Compact 860×600](proof/desktop-ui/compact-860x600.png)
- [Minimal 640×600](proof/desktop-ui/minimal-640x600.png)
- [Minimal Sidebar overlay](proof/desktop-ui/minimal-sidebar-overlay.png)
- [Minimal Inspector overlay](proof/desktop-ui/minimal-inspector-overlay.png)
- [Native menu → collapsed sidebar](proof/desktop-ui/native-menu-sidebar-collapsed-1180x780.jpeg)
- [80% application zoom](proof/desktop-ui/zoom-80-1180x780.jpeg)
- [150% application zoom](proof/desktop-ui/zoom-150-1180x780.jpeg)
- [200% application zoom → local table overflow](proof/desktop-ui/zoom-200-table-overflow-1180x780.jpeg)
- [Per-window draft/zoom capture](proof/desktop-ui/multi-window-draft-zoom-seth.jpeg)
- [Per-window draft/scroll capture](proof/desktop-ui/multi-window-draft-scroll-maya-persistence.jpeg)
- [SIGKILL/relaunch state restore](proof/desktop-ui/crash-reload-draft-scroll-restored.jpeg)
- [Three-window independent state](proof/desktop-ui/three-window-third-state.jpeg)
- [Three-window SIGKILL restore](proof/desktop-ui/three-window-sigkill-restored.jpeg)

已通过的自动验证（2026-08-11 当前 worktree）：Renderer `24 files / 109 tests`；Rust `44 passed / 1 ignored Keychain smoke`；Runtime Node test `226 passed`；LocalRunner `43 passed`；Web build；Tauri preview/release `.app` build；production-session `cargo check`。Renderer style contract 也锁定了 system `color-scheme`、system accent、Increase Contrast、Reduced Motion 与 visible focus，确保 WebKit 原生控件跟随 Light/Dark，并锁定 shell overflow、container-query tiers 与结构化内容的局部横向滚动；Conversation snapshot 现在会在确认 cursor 前验证 journal 顺序、事件类型、Run 引用并做 cursor 幂等去重。另有 macOS preview UAT 验证 dynamic conversation-window manifest 的 Cmd-Q 保留、下次启动恢复及单窗关闭清理；三窗口持久化 fixture 进一步验证了三个动态窗口各自的 Agent、draft、workspace grant、zoom、scroll 与 pane state，两个 preview 进程被 `SIGKILL` 后 manifest 仍保留三个 IDs，焦点窗口通过 native app-data 恢复（不等同于 cloud Conversation/Run recovery）；preview 还提供 native workspace picker、grant-bound artifact Reveal/Quick Look/Open 的可重复 UAT fixture，并已在有效 grant 下打开可见的系统 `QLPreviewPanel`（证据见 `quick-look-native-panel.jpeg`）。Runtime 验证必须使用独立的 `HATCH_RUNTIME_DATA_DIR`，避免复用旧的 durable idempotency fixture。

详细的逐条状态、证据和外部验收边界见 [Desktop UI v1 验收矩阵](proof/desktop-ui/acceptance-matrix.md)。矩阵区分本机 PASS、实现但缺环境的 PARTIAL/EXTERNAL，以及明确延期的 DEFERRED；本 spec 在 P4 所列跨平台条件全部通过前不会标记为 complete。

## 目标

- 让 Hatch 在窗口缩放、菜单、键盘导航、拖拽、多窗口、状态恢复和系统集成方面表现为真正的桌面应用。
- 将 Creator Agent、Conversation、Run、Window Session 与本机 Workspace Authorization 建模为明确的产品及工程对象。
- 将 secret、文件系统 authority、approval authority 和持久化桌面状态移出 renderer。
- 保留 React/WebView 擅长的内容：streaming transcript、Markdown、code、table、tool activity、composer 及 Agent-specific rich content。
- 在 macOS 和 Windows 上提供符合各自平台习惯的行为，而不是强求像素级一致。

## V1 非目标

- 用 AppKit 或 WinUI 原生控件重写 conversation transcript 或 composer。
- 只为 macOS 构建 Native AppKit sidebar，同时让 Windows 停留在另一套产品架构。
- 把 Tauri 持有的 WKWebView 或 WebView2 reparent 到自定义 Native split-view hierarchy。
- 在本计划内评估或迁移 AppKit/WinUI Native shell。
- 用 HTML 重画系统 traffic lights 或 Windows caption buttons。
- 把 mobile web breakpoint 当作桌面窗口行为。

## 目标架构

```text
Tauri / Rust native layer
├── OS window、app menu、context menu、shortcuts
├── Keychain / Credential Manager
├── Native app-data、window restoration
├── Workspace authorization、approval state
├── Picker、drag/drop、notifications、Finder/Explorer integration
└── WebView
    └── React DesktopShell
        ├── Collapsible Sidebar
        ├── Integrated Toolbar
        ├── Resizable Conversation Surface
        ├── Optional Inspector
        └── Transcript、Markdown、tools、composer
```

V1 的 DesktopShell 由 React 实现，但必须遵守桌面 layout 与 interaction contracts。Native 层持有操作系统窗口、系统集成、privileged state 和安全边界。

## 状态与 authority 模型

| 对象或状态 | 权威归属 | 最小职责 |
| --- | --- | --- |
| Creator Agent access | Registry / Postgres | Account 对 Creator Agent 的当前访问权及 Library projection |
| Conversation | Cloud Runtime / Postgres | ID、owner、固定 Creator Agent binding、title、status、timestamps、version |
| Messages 与 conversation events | Cloud Runtime / Postgres | 使用单调 event cursor 的持久有序历史 |
| Run | Cloud Runtime / Postgres | lifecycle、active-run exclusion、server executor ownership、cancel、observer recovery；V1 不提供 executor reclaim |
| Opaque session token | OS credential vault | macOS 正式签名包使用 Developer-ID-gated Keychain；Windows 在经过 threat-model 证明的 device-bound backend 实现并验收前只使用进程内 session。MSIX/AppContainer PasswordVault 不视为足够的 app-only boundary；dev 与 ad-hoc UAT 始终使用进程内 session，token 使用期间驻留 memory |
| Workspace Authorization | Rust | 当前 window/conversation 对应的、由 Native picker/drop 选中的 authoritative root 与 capability |
| Conversation 本机偏好 | Native app-data | Workspace reference、permission、shell policy 等机器相关且非敏感的本地关联 |
| Window Session | Native app-data / SQLite | window ID、conversation ID、bounds、zoom、sidebar、inspector、composerDraft、conversation cursor、viewport scrollTop、dismissed interrupted-run ID |
| 瞬时 view state | 当前 renderer | IME composition、selection、popover 等不应恢复的 UI 状态 |

## 产品层级

```text
Account
└── Purchased Creator Agents[]（当前 access grants）
    ├── Creator Agent A
    │   ├── Conversation 1
    │   ├── Conversation 2
    │   └── Conversation 3
    └── Creator Agent B
        ├── Conversation 1
        └── Conversation 2
```

一个 Account 可以拥有多个 Creator Agents；每个 Creator Agent 可以拥有 `0..N` 个 Conversations。Conversation 归 Account 所有，并在创建时永久绑定 `creator_id + agent_id`；切换 Agent 意味着新建 Conversation，而不是修改已有 Conversation 的 Agent。

`product_id_at_creation` 用于购买与交付审计，`created_via_entitlement_id` 可以作为可选审计字段，但 entitlement/access grant 不是 Conversation 的生命周期父对象。Access 被撤销后至少禁止启动新 Run；历史读取策略应由单独产品规则明确。

Workspace 是机器相关的本机偏好，不是云端 Conversation 字段。同一个 Conversation 在另一台机器打开时恢复云端历史，但必须重新选择本机 Workspace。

## Desktop UX 契约

### 窗口与导航

- 一个 Hatch 窗口代表一个独立工作上下文。
- 每个窗口拥有自己的 active Conversation、Workspace Authorization、Sidebar、Inspector、draft、zoom 和 frame。
- Sidebar 管理 Agents 与 Conversations。
- Toolbar 描述当前 Agent、Conversation 和 Workspace，只暴露高频动作。
- Inspector 承载 permission、shell access、Agent boundary、Run detail 与 tool detail。
- Settings 与 About 使用独立窗口或 panel。
- Approval 必须附着在负责该 Run 的窗口上。

### 窗口缩放与 zoom

- Sidebar 与 Inspector 可调整大小，并按窗口保存宽度和显隐。
- 窗口变窄时先隐藏 Inspector，再把 Sidebar 折叠为 off-canvas。
- Conversation surface 与 Composer 始终保留。
- Sidebar 不得像移动网页一样堆到 Conversation 上方。
- Code、diff、table 和 tool output 可在自身区域滚动，但不得造成页面级横向滚动。
- 初始验证使用暂定的 `640×600` minimum window size，以及 80%–200% zoom；最终限制必须经过 macOS 与 Windows 测试后确定。
- OS display scaling 与 application zoom 作为两个独立输入处理。

### Collapse 与 Overflow Contract

Native-like 的窄窗行为不是让所有内容连续缩小和自动换行，而是以离散 layout state 保住任务结构。Minimum window width/height 只是最后一道 guardrail，不能代替布局策略；这里约束的是最小宽高，不用“最小面积”表达。

#### Layout tiers

每个窗口只进入以下三个可解释状态：

| Tier | Pane composition | 行为 |
| --- | --- | --- |
| `regular` | Sidebar + Main + Inspector | 三栏可见，用户可拖动 divider |
| `compact` | Sidebar + Main | Inspector 自动折叠，可从 toolbar 临时打开 |
| `minimal` | Main | Sidebar 与 Inspector 作为 leading/trailing overlay 打开，不参与 Main 尺寸计算 |

当 Main 已达到 `mainMin` 后，窗口停止继续缩窄。阈值由 pane constraints 计算，不使用设备类型或固定的 mobile breakpoint：

```text
collapseInspectorAt = sidebarPreferred + mainMin + inspectorMin
collapseSidebarAt   = sidebarMin + mainMin
windowMinWidth      = mainMin
```

计算使用 application zoom 后的 CSS pixels。进入和退出相邻 tier 使用约 `24–40px` hysteresis，避免在临界宽度 resize 时来回闪烁；具体值在双平台真机测试后确定。

用户意图与当前布局必须分开保存：

```text
sidebarPreference: open | closed        // 按窗口持久化
sidebarWidth: number                    // 按窗口持久化
inspectorPreference: open | closed      // 按窗口持久化
inspectorWidth: number                  // 按窗口持久化
layoutTier: regular | compact | minimal // 从当前尺寸推导，不持久化
sidebarOverlayOpen: boolean             // transient
inspectorOverlayOpen: boolean           // transient
```

自动 collapse 不得覆盖用户的 `open | closed` preference。窗口重新变宽时，只恢复因为空间不足而自动折叠、且用户 preference 仍为 `open` 的 pane。Compact Sidebar 是完整 source list 的 overlay，不变成没有可靠 label 的 icon rail，也不插入 Conversation document flow。

#### Semantic overflow

Overflow 按内容语义处理，而不是统一套用 `flex-shrink`、`overflow-wrap: anywhere` 或 viewport clipping：

| 内容 | 规则 |
| --- | --- |
| Toolbar commands | 保持单行；低优先级 command 作为完整 item 移入一个 Native `…` menu，不缩成残字、不换行 |
| Agent / Conversation title | 单行 tail ellipsis；tooltip 或 accessibility description 提供完整名称 |
| Path、filename、identifier | 优先 middle ellipsis；Copy Path/Copy Value 始终复制完整值 |
| 自然语言、error message | 按词自然换行；长 URL 才允许 break-word |
| Markdown table | 保持列的语义最小宽度，在 table wrapper 内横向滚动 |
| Code、diff、log | 保留行结构，在自身区域横向滚动；可以提供显式 Wrap Lines command |
| Sidebar / Inspector | 整个 pane collapse；不把内部 rows 压成不可辨认碎片 |
| Composer | 输入区与 Send/Stop 固定可达；Workspace、permission 和次要动作整体进入 overflow |

整个 WindowShell 不得出现页面级横向滚动。每个 pane 只有一个纵向 scroll owner：Sidebar 的 list、Conversation viewport 和 Inspector content 分别滚动；结构化 artifact 可以拥有局部横向滚动，但不得再建立同轴的嵌套纵向滚动。Composer 位于 Conversation scroller 之外并保持固定；必要时由 Conversation viewport 设置底部 `scroll-padding`。

Toolbar 在 `minimal` tier 至少保留 Sidebar toggle、Conversation title、活动中的 Stop 和单一 overflow button。常驻的 `More` 与自适应产生的 overflow 必须合并成一个菜单；菜单项来自同一 Command Registry，保持与 application menu、context menu 和快捷键一致。

Composer 不允许依靠压缩 children 来“挤进去”。宽度不足时按 priority 整项迁移或隐藏次要 controls，并把能力保留在 overflow/menu 中；Send 或 Stop 不能被裁切，placeholder 也不重复塞入很长的 Agent 全名。

#### Structured content implementation

Markdown table 的 scroll container 必须是 wrapper，不能把 `<table>` 自身改成 `display: block`：

```jsx
<div className="markdown-table-scroll" tabIndex={0}>
  <table>{children}</table>
</div>
```

```css
.markdown-table-scroll {
  max-inline-size: 100%;
  overflow-x: auto;
  overscroll-behavior-inline: contain;
}

.markdown-table-scroll table {
  display: table;
  inline-size: max-content;
  min-inline-size: 100%;
}

.markdown-table-scroll th,
.markdown-table-scroll td {
  min-inline-size: 8rem;
  word-break: normal;
}

.markdown-table-scroll code {
  white-space: nowrap;
  overflow-wrap: normal;
  word-break: normal;
}

.markdown-body pre {
  overflow-x: auto;
  white-space: pre;
  overflow-wrap: normal;
  word-break: normal;
}
```

普通 prose 使用 `overflow-wrap: break-word`，不得让 table identifier、inline code 或 file path 逐字符断裂。Table/code overflow 应通过 edge fade、scrollbar 或露出部分下一列来保持可发现性，而不是把超出的内容静默裁掉。

#### Layout controller 与 interaction

- `WindowLayoutController` 结合当前 container inline size、已保存的 pane widths 和 `mainMin` 推导 tier；只在 tier 改变时更新 React state，不在 resize 的每一个 pixel 触发 component tree rerender。
- WindowShell 使用 `data-layout="regular|compact|minimal"` 和明确的 pane state 作为 CSS contract。Grid/Flex 中所有允许收缩的 Main children 必须设置 `min-width: 0` 和 `min-height: 0`。
- Pane composition 由 layout controller 管理；Toolbar、Composer 与 Markdown presentation 的局部密度使用 container queries，不读取全局 viewport breakpoint。
- Live window resize 不播放 collapse transition；用户明确点击 toggle 时才可使用短动画，并尊重 Reduced Motion。
- Sidebar 的结构保持固定 header、单一滚动的 Conversation tree、固定 footer，不让整个 Sidebar 随内容无限增长。
- Divider 遵循 WAI-ARIA Window Splitter pattern，支持 Arrow keys 调整、Enter collapse/restore、双击恢复默认宽度，并暴露当前、最小和最大值。
- Toggle 使用 `aria-controls` 与 `aria-expanded`。Pane 隐藏后必须从 tab order 和 accessibility tree 移除；若 focus 位于即将自动折叠的 pane 内，先把 focus 移到对应 toggle 或 Main 中的逻辑目标。
- Overlay 建立清晰 focus scope，`Escape` 关闭并把 focus 返回 opener；overflow button 使用 `aria-haspopup="menu"`，菜单关闭后同样恢复 focus。

### 键盘与拖拽

- 每个重要动作都必须对应 semantic command、menu 和可通过键盘完成的路径。
- 文件夹拖到 Workspace target 可创建或更新当前窗口的 Workspace Authorization。
- 文件拖进 Composer 可添加为上下文：Native 在 drop gesture 发生时验证并读取 bounded UTF-8 snapshot，随后只保存 window-scoped、短生命周期、one-shot 的 opaque handle；发送时不重新打开路径，也不把路径 authority 交给 renderer。Renderer 只看到文件名与 attachment chip，不看到绝对路径、bookmark 或 grant；单文件 projection 最多 64 KiB、source 最多 1 MiB、最多 8 个、总 projection 最多 128 KiB，binary/不符合 UTF-8 或超限文件在 Native boundary 被拒绝并显示受限说明。发送使用 wire protocol `0.7` 的结构化 `message.attachments`（`attachment_id`、display name、MIME、source bytes、bounded text、SHA-256、truncated），Runtime 再校验并以明确的 untrusted framing 生成模型输入、写入 journal；附件不获得后续 filesystem authority。
- 所有 drag-and-drop 操作都有 picker、menu 或 keyboard 等价路径。
- IME composition 期间不得误触发 send、stop 或 global command。
- `Escape` 只关闭 transient UI，不停止 Run。

### 布局原语与 accessibility

Renderer 应建立稳定的 desktop primitives，而不是继续累积 page-level CSS classes：

- `WindowShell`
- `Sidebar`
- `Toolbar`
- `SplitView`
- `ListRow`
- `Inspector`
- `Composer`
- `Sheet`
- `EmptyState`

Tokens 使用语义命名，例如 `surface.sidebar`、`border.separator`、`text.secondary`。组件契约必须覆盖 Light/Dark Mode、system accent、Increase Contrast、Reduced Motion、focus order、visible focus、screen-reader label 与 announcement、text selection 和完整键盘操作。

## 视觉语言

- macOS 使用 overlay title bar、隐藏文字标题，并保留系统 traffic lights。
- Windows 保留 native frame 与 caption buttons，继续获得 Snap Layout、system menu、Narrator、DPI、RTL 和正确的 hit region。
- Sidebar 延伸到 title-bar 区域下方，并从工作界面移除独立 Hatch 品牌卡片。
- Toolbar 与 title bar 形成一个整体。
- Sidebar 使用 source-list rows、selection、separator 和 hierarchy，不再把每一项放进 rounded card。
- 减少嵌套 border、shadow 与 card。
- 工作界面 chrome 使用系统字体。
- 品牌衬线字体只用于 sign-in、empty state、About，以及 Markdown `H1/H2`；Markdown `H3` 使用系统字体。
- Tauri macOS overlay title bar 只作为薄 platform adapter，并在真实 macOS 版本上验证高度、拖动、focus 与 fullscreen 行为。

## 交付计划

### P0：集成基线与安全边界

1. 等活跃 PR 合并状态稳定后，把专用 desktop UI worktree 同步到最新集成基线。
2. 用 ADR 记录 Tauri Hybrid V1 决策。
3. 统一并锁定 npm 与 Cargo 中兼容的 Tauri minor version，提交 `Cargo.lock`。
4. 为 main window 和 Conversation windows 定义 Tauri app manifest 与 capabilities。
5. 复用已经合并的 [PR #10](https://github.com/keithhchen/hatch/pull/10)，不重复实现 authentication storage：
   - PR #10 已移除 auth token 的 `localStorage` 与 `VITE_HATCH_AUTH_TOKEN` 路径；
   - 当前服务端使用 opaque session token，不存在需要在本计划中虚构的 refresh/access token 分层；
   - macOS 正式签名包将 opaque session token 保存到 Keychain，并把 settings 迁入 Native app-data；Windows 不能把 Win32 Generic Credential Manager 当作对等实现：Microsoft 明确该类 credential 可由 user processes 读写，Authenticode 不能把它变成 app-only vault；
   - `tauri dev` 与 ad-hoc UAT 默认不读写真实 secure store，避免临时 code identity 反复触发系统解锁；
   - 只有 CI 明确设置 `HATCH_PERSISTENT_SESSION=1`、完成稳定签名与 identity 校验的发行包才启用持久 secure storage；macOS 还必须编入预期 Team ID，并在 runtime 以 Security.framework 验证 Developer ID Application、bundle identifier 与 Team ID。Windows 当前遇到该 flag 必须 fail-closed；只有在另立的 device-bound/session-challenge backend 证明了 app-only 或设备绑定边界，并通过同用户 full-trust 进程负测、签名发布与真机 UAT 后，才可讨论持久化，不把 MSIX/AppContainer PasswordVault 当作充分条件；
   - production credential namespace 与历史 dev/UAT Keychain item 分离，启动不迁移旧 item；不能为消除系统提示而放宽 ACL、调用 `security` CLI 或回退到 Web Storage；
   - 同步最新 master 后先验证已有行为和 tests，再处理剩余平台缺口。
6. 在 Rust 中建立最小 `WorkspaceContext`，复用现有 Native `WorkspaceGrantStore`，但不把它扩展成通用权限平台：
   - Workspace 只能来自 Native folder picker 或 Native file-drop event；
   - 已有的 opaque `grant_id → canonical root/platform handle` 是 Native authority；每个 `WindowContext` 在任一时刻至多绑定一个 active grant；
   - Rust 按当前 window/conversation 保存 active grant、account 与 capability；`execute_tool_call` 不再接收 renderer 传入的 `workspaceRoot`，而是从当前窗口的 Native context 解析 Workspace；
   - structured filesystem tool arguments 继续只接受 relative path，并复用现有 `local-runner` containment 与 symlink checks；
   - renderer 可以获得 display path 用于 presentation，但不能用该 path 改写 authority；
   - V1 不需要增加 buyer/task/product/TTL/nonce 的多维授权 ledger；现有 grant store 只承担用户选择的 Workspace access、revalidation、revoke 与按窗口绑定。
   - `shell.exec` 是单独 capability：当前 `local-runner` 已对 structured file tools 做 relative-path、canonical containment 与 symlink checks；macOS shell 使用 Seatbelt，非 macOS V1 fail-closed，不能把“设定 cwd”当作授权边界。V1 不把 shell 纳入 `Allow changes` 的自动授权：每次都展示完整命令并进入 Native high-risk approval。Windows 的受限 shell backend 另立安全任务，不作为 grant 复杂度的一部分。
7. 用最小 Rust approval state machine 取代可由请求伪造的 `approved_by_user` 字符串：
   - Rust 保存 pending tool call 与当前 permission policy；
   - renderer 只能针对已存在的 `tool_call_id` 发出 approve/deny action；
   - 不引入签名 token 或 cryptographic capability；
   - 这一步阻止 cloud/model payload 自称已获批准，但不宣称能够抵御整个 renderer 被攻陷。若未来要求强 user-presence guarantee，再评估 Native approval sheet。
8. 扩展 PR #10 已有的 Native app-data settings，使用按字段 patch 或等价的原子更新支持多窗口。只有并发与 migration 复杂度证明 JSON app-data 不够时才引入 SQLite。

### P1：Desktop shell 与 split layout

1. 使用 platform-specific adapter 实现 integrated title bar 与 Toolbar。
2. 引入 desktop layout primitives 与 semantic design tokens。
3. 将 Sidebar 改为 source list，把 permission 与 tool detail 移入 Inspector。
4. 实现可拖动的 Sidebar 与 Inspector separator，并支持：
   - pointer 与 keyboard 操作；
   - accessible separator role/value；
   - minimum/maximum width；
   - 双击恢复默认宽度；
   - 按窗口保存宽度和显隐。
5. 实现 `WindowLayoutController`，以 `regular`、`compact`、`minimal` 三个 tier 替换当前 `860px` mobile-style breakpoint：
   - 由 pane constraints 与 container inline size 推导 tier；
   - 区分 persisted user preference、auto-collapse 与 transient overlay；
   - 加入 hysteresis，避免临界宽度振荡；
   - Inspector 先于 Sidebar 自动折叠，Main 永远不被堆叠到 Sidebar 下方。
6. 为 Toolbar、Composer 与 Markdown content 建立 semantic overflow：
   - command priority 与 Native overflow menu 接入统一 Command Registry；
   - Send/Stop 与活动 approval 永远可达；
   - 实现 `MarkdownTable` scroll wrapper，以及 code/diff/log 的局部横向滚动；
   - 从 structured content 移除 `overflow-wrap: anywhere` 与逐字符断行。
7. 明确每个 pane 的唯一纵向 scroll owner，并实现 compact overlay 的 keyboard、focus return、`inert`/accessibility tree 与 Reduced Motion 行为。
8. 恢复窗口位置与尺寸，同时把 frame 约束在当前可用显示器范围内。
9. 恢复 dynamic windows 时先以 `visible: false` 创建，避免启动闪烁。

### P2：Conversation Library、持久 Run 与多窗口

Conversation 必须成为一等 cloud object，而不是 client 生成 ID 后清空 React state。Conversation 永久归属于一个 Account，并固定绑定一个 Creator Agent。

最小字段：

```text
Conversation
- id
- owner_account_id
- creator_id
- agent_id
- product_id_at_creation
- created_via_entitlement_id?   // 仅审计
- title
- status: active | archived
- created_at
- updated_at
- version

ConversationRun
- id
- conversation_id
- status
- corpus_digest
- created_at / started_at / completed_at
```

Runtime 至少提供：

- 幂等创建 Conversation；服务端根据当前 Account 与 active access grant 推导 Creator/Product，客户端不能改写 binding；
- 按 `agent_id`、status 和 cursor 分页列出 Conversations；
- 获取和更新 Conversation metadata；
- 从 event cursor 之后读取 messages/events；
- 创建、查看与取消 Run；
- 通过数据库约束保证每个 Conversation 最多存在一个非终态 Run；
- subscribe Conversation，并在重连后通过 snapshot + event cursor replay missing events；
- V1 不 attach/reclaim active Run：断线或 Runtime 重启将非终态 Run 标为 `interrupted`，不重放 tool。未来若要 reclaim，必须另立 executor fencing/lease ADR，不能由客户端自行接管。

Library 按 Creator Agent 分组显示 Conversations。一个 Creator Agent 下可以创建任意多个 Conversation；切换 Creator Agent 时展示该 Agent 自己的 Conversation 列表，不复用其他 Agent 的 Conversation ID。

窗口行为：

- `Cmd/Ctrl+N`：当前窗口可以安全离开时，在其中创建 Conversation。
- `Cmd/Ctrl+Shift+N`：在新窗口创建 Conversation。
- Conversation context menu 提供 `Open in New Window`。
- 当前窗口持有 active Run 时，新 Conversation 必须在另一个窗口打开，不得清空或停止当前任务。
- V1 为每个 Conversation 指定一个 primary executor window；再次打开时聚焦已有窗口，避免重复 approval executor。
- 关闭窗口不删除 Conversation。
- network disconnect、renderer reload 或 application restart 后，通过 snapshot + event cursor reconciliation 恢复 Conversation；正在执行的 Run 进入明确的 `Interrupted`，不会被客户端或 Runtime 自动重放。
- 若 renderer 在进程退出前来不及写入 `activeRun`，启动后的 snapshot 仍会把 durable `interrupted` Run 投影为只读恢复 banner；用户明确关闭后按 run ID 记录 dismissal，避免下一次 hydration 反复弹出同一任务。
- local-tool 或 approval 只路由到当前 executor window；V1 不在另一个窗口重新接管 executor，避免重复 tool execution。
- logout、token expiry 与 entitlement change 广播到所有窗口。

### P3：Native commands 与系统集成

所有入口使用同一个 Semantic Command Registry。初始 command IDs：

```text
conversation.new
conversation.newWindow
conversation.rename
conversation.archive
workspace.choose
sidebar.toggle
inspector.toggle
run.stop
view.zoomIn
view.zoomOut
view.zoomReset
artifact.reveal
artifact.quickLook
artifact.copyPath
tool.copyOutput
settings.open
about.open
```

Application menu、Toolbar、shortcuts 与 context menus 共用 command label、enablement 和 focused-window routing。

#### Native Command Registry contract

- Rust 保存每个 `WebviewWindow` 的完整、仅展示用 `NativeCommandState`：`newConversationEnabled`、`newWindowEnabled`、`workspaceEnabled`、`settingsEnabled`、`runStopEnabled`、`sidebarVisible`、`inspectorVisible`。renderer 只能通过 `set_native_command_state({ state })` 更新 Tauri 注入的**当前**窗口，不能传 window label；它不授予 workspace、tool、account 或 conversation authority。
- 没有可路由的 Hatch window 时，Native application menu 的 product commands 必须 disabled。`Focused(false)` 不应过早清空最后一个 Hatch window，因为点击 macOS/Windows native menu 可暂时移开 WebView focus；另一个 Hatch window 的 `Focused(true)` 替换目标，`Destroyed` 必须清除它的 command state、pending context target 和 conversation-window registry entry。
- Sidebar / Inspector 使用 Native `CheckMenuItem`，check state 来自该窗口的 command snapshot。菜单选择可乐观翻转 checkmark；若 event delivery 失败必须回滚，下一次 renderer 完整 snapshot 为最终真相。
- Toolbar 的唯一 `…` 调用 `show_native_command_menu({ request: { position } })`。Native menu 必须从同一 registry 构建，至少包含 New Conversation、New Window、Open Workspace、Sidebar、Inspector、Zoom In/Out/Actual Size、Stop Run 与 Settings；不得由 renderer 传入任意 menu item 或 enablement。
- `artifact.reveal` 已通过 `reveal_workspace_artifact({ workspaceGrantId, relativePath })` 接入 Finder/Explorer；`artifact.quickLook` 通过同一 grant-bound contract 接入：macOS 在主 AppKit 线程显示系统 `QLPreviewPanel`（面板不可用时回退到 `qlmanage` launcher），Windows 调用 ShellExecute `open`，其他 Unix 使用 `xdg-open`。Rust 在每次调用前重新解析 grant、canonicalize 并检查 containment；未通过 grant 校验时不能启动任何外部 opener。

Native 交付顺序：

1. Application menu、Native context menu、parented picker/dialog、window-state integration。
2. Notifications、Finder/Explorer integration、Quick Look/Open，以及 Dock/taskbar attention（当前实现已覆盖；Windows 与 signed-package UAT 仍在 P4）。
3. Settings/About windows、少量 title-bar accessories，以及适合 Native 呈现的低频高风险 approval。

Context menu 规则：

- Conversation row、tool result 和 artifact 使用 Tauri Native popup menu。
- Editable text 和 Composer 尽量保留操作系统 editing context menu，保留 spelling、Lookup、Services、Undo、Cut、Copy 与 Paste。
- Product build 的产品区域绝不出现 `Inspect Element`。
- Development build 仅通过明确的 Debug command 开放 DevTools。

需要补齐的 Desktop 行为：

- Conversation：Rename、Archive、Open in New Window。
- Artifact：Reveal in Finder/Explorer、Quick Look/Open、Copy Path。
- Approval 同时 inline 展示，并在 Composer 上方形成 sticky action。
- Background window 需要 approval 时请求 Dock/taskbar attention。
- `Cancelled`、`Failed`、`Offline`、`Needs Approval` 是不同状态；用户主动 Stop 不得显示为失败。

当前 worktree 已交付的 P3 子集是 application menu、toolbar overflow、conversation/tool-result/artifact 的 native context popup、semantic command routing、per-window command enablement/check state、native conversation-window lifecycle、zoom commands、parented Workspace picker/drop、grant-bound Finder/Explorer Reveal、grant-bound Quick Look/Open、non-modal Dock/taskbar attention，以及独立 Settings/About auxiliary windows。macOS native menu UAT 已确认 artifact 菜单显示 `Quick Look`，并在有效 grant 下实际显示可见的系统 `QLPreviewPanel`；Windows `ShellExecuteW` 与高 DPI/Explorer 行为仍需 Windows 真机验收。

### P4：跨平台验收

V1 只有在以下条件全部通过后才算完成：

- 一个 Account 可以在 Creator Agent A 下创建三个 Conversations、在 Creator Agent B 下创建两个，并在正确层级中列出。
- Creator Agent A 的 Conversation ID 不能作为 Creator Agent B 的 Conversation 打开或执行。
- 三个并行窗口可以使用不同的 Conversation、Workspace Authorization、draft、zoom、Sidebar 和 Inspector，不发生状态串联或 last-writer-wins 数据丢失。
- Conversation 创建请求重试时保持幂等，不产生重复对象。
- 关闭一个窗口不影响其他 Conversation 或 Run。
- network disconnect、renderer reload、application crash 恢复后，通过 snapshot/cursor observer recovery 不出现重复 user message、assistant placeholder 或 event；进行中的 Run 显示 `Interrupted`，V1 不自动 reclaim 或重放工具。
- Authentication secret 不出现在 Web Storage、URL、log、settings 或 Conversation data 中；正式签名 macOS Keychain 通过 packaged-app 验证；dev/ad-hoc UAT 与当前 Windows 包只能使用进程内 session，不能把 raw token 写入浏览器存储作为替代。macOS release UAT 还必须验证重启后的 Keychain read/write 无 unlock prompt，且 `codesign -dvvv` 的 Developer ID Application、Team ID 与 bundle identifier 均与 CI configuration 一致。Windows persistent-session acceptance 只有在 device-bound backend 与 same-user full-trust 负测通过后才可开始；PasswordVault 不满足该门槛。
- Renderer 无法通过传入 arbitrary absolute workspace path 扩大授权；Rust 测试继续拒绝 `..` traversal、absolute tool path、symlink escape、cleared Workspace 与 capability violation。
- Product context menus 使用 Native menu，且不出现 `Inspect Element`。
- `640×600`、`860×600`、`1180×780` 在 80%、100%、150%、200% zoom 下无页面级横向滚动；Sidebar、Composer、Stop 与 Approval 始终可达。
- 在 `regular → compact → minimal` 与反向 resize 中，Inspector 总是先于 Sidebar 自动折叠；Sidebar 不会堆叠到 Conversation 上方，overlay 打开也不会压缩 Main。
- Auto-collapse 不覆盖用户保存的 pane preference；窗口重新变宽后只恢复自动折叠的 pane，并且在阈值附近无反复开合。
- Toolbar 与 Composer controls 不换行、不显示残字、不互相覆盖；次要动作进入同一个 overflow menu，Send/Stop 在所有 tier 都可操作。
- Table、code、diff 与 log 保留结构并只在自身区域横向滚动；identifier 不逐字符断行，整个窗口不存在横向滚动。
- Compact overlay 支持完整键盘操作、`Escape`、正确的 focus transfer/return，并从隐藏状态的 tab order 与 accessibility tree 中移除。
- Live resize 不因 collapse animation 产生明显抖动；Reduced Motion 下无非必要 pane transition。
- VoiceOver 与 Narrator 能完成主流程。
- Tab order、menu shortcut、text selection、中文 IME、drag/drop、Native-WebView focus、fullscreen、Windows Snap 与多显示器 DPI change 均通过目标平台测试。
- Light Mode、Dark Mode、Increase Contrast、Reduced Motion 与 system accent 行为通过。

## 实施顺序

建议拆分为以下 Pull Requests：

1. 集成基线、ADR、version locking 与 capabilities。
2. 单独评估 Windows secure session backend：优先 device-bound/session-challenge 或 Windows Hello/passkey 方案；必须先完成 threat-model、同用户 full-trust 负测、Windows signing CI 与真机验收。在此之前保持进程内 session，并实现最小 Rust WorkspaceContext 与 approval state。
3. Desktop primitives、title-bar treatment 与 resizable split layout。
4. Conversation 与 Run service contracts。
5. Conversation Library、multi-window lifecycle 与 restoration。
6. Native menu、context menu、commands、picker 与系统集成。
7. Cross-platform accessibility、scaling 与 recovery hardening。

## 研究与决策方法

每个实施阶段都遵循相同过程：

1. 查阅最新的一方平台文档。
2. 平台行为不确定时，先做窄范围 prototype。
3. 在 production implementation 前定义 macOS 与 Windows acceptance tests。
4. 只使用受支持 API 实现。
5. 在真实目标操作系统和硬件配置上验证。
6. 在仓库中记录 architecture decision 与 exception。

主要参考：

- [Tauri Menu](https://v2.tauri.app/learn/window-menu/)
- [Tauri Menu JavaScript API](https://v2.tauri.app/reference/javascript/api/namespacemenu/)
- [Tauri Window State](https://v2.tauri.app/plugin/window-state/)
- [Tauri Capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri Dialog](https://v2.tauri.app/plugin/dialog/)
- [Apple: Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)
- [Apple: Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Apple: Split views](https://developer.apple.com/design/human-interface-guidelines/split-views)
- [Apple: Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Apple: Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)
- [Apple: Drag and drop](https://developer.apple.com/design/human-interface-guidelines/drag-and-drop)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)
- [Apple Quick Look UI](https://developer.apple.com/documentation/quicklookui)
- [Apple QLPreviewPanel](https://developer.apple.com/documentation/quicklookui/qlpreviewpanel)
- [Microsoft: Title bar customization](https://learn.microsoft.com/en-us/windows/apps/develop/title-bar?tabs=winui3)
- [Microsoft: NavigationView](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/navigationview)
- [Microsoft: Command bar](https://learn.microsoft.com/en-us/windows/apps/design/controls/command-bar)
- [Microsoft: ShellExecute](https://learn.microsoft.com/en-us/windows/win32/shell/launch)
- [Microsoft: Credential Locker](https://learn.microsoft.com/en-us/windows/apps/develop/security/credential-locker)
- [Microsoft: PasswordVault app isolation](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.passwordvault)
- [Microsoft: Detect package identity](https://learn.microsoft.com/en-us/windows/msix/detect-package-identity)
- [WAI-ARIA: Window Splitter Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)

## 总结

```text
P0 Security 与 authority boundaries
  → P1 Desktop shell 与 split layout
  → P2 Conversation 与 multi-window model
  → P3 Native affordances 与 commands
  → P4 Cross-platform acceptance
```

除非后续 ADR 明确取代本方案，这份文档就是 Hatch Desktop UI construction 的实施基线。
