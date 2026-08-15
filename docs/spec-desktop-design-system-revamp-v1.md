# Hatch Desktop Design System Revamp v1

- 状态：Implementation plan
- 日期：2026-08-14
- 范围：只改视觉呈现与组件复用，不改变任何产品功能、状态模型或 Native authority
- 设计基线：Light mode、Atmospheric Paper、Instrument Serif display、macOS system sans UI、Inter labels/pills

## 结论

Desktop 不需要重做产品结构。当前的 Tauri/React shell、三档窗口布局、Conversation Library、Runtime stream、Workspace grant、tool approval、native commands、窗口恢复与 accessibility contracts 都应原样保留。

要改的是 renderer 的视觉实现方式：从大量 page-level CSS 和零散原生元素，迁移到 `@hatch/ui` 的 tokens、primitives 和固定品牌资产。改完后，Web、Desktop 与 Storybook 使用同一套 Button、Dialog、Dropdown、Select、Feedback、logo 和 Atmospheric Paper 配方；Desktop 只保留真正属于桌面产品的复合组件。

## 当前实现审阅

### 应完整保留

- `DesktopWindowShell` 的 `regular / compact / minimal` tier、pane preference、overlay 与 split divider 行为。
- Sidebar 对 Agent / Conversation 的真实数据绑定，以及 select、new、rename、archive 和 context menu command。
- Toolbar 的 Tauri drag region、sidebar/inspector toggle、native overflow menu 和 connection recovery。
- Assistant UI Runtime、streaming transcript、Markdown、tool/skill activity、inline approval 和 Send/Stop。
- Workspace picker/grant、native file drop、permission policy、IME、keyboard 和 focus contracts。
- Auth、entitlement、Conversation/Run persistence、多窗口、settings/about window 与 native bridge。
- 现有 fail-closed 行为。真实依赖不可用时继续显示真实 unavailable/error，不加入 fixture fallback。

### 当前视觉债务

- `main.jsx` 约 5,000 行，同时容纳真实 product wiring 和多数 view components；迁移时必须只抽 view，不移动 authority 或 lifecycle。
- `styles.css` 同时负责旧 shell、登录页、Conversation、Markdown、工具活动和新 Desktop shell，约 2,800 行；视觉 ownership 不清晰。
- `desktop-shell.jsx` 约 445 行，已经形成稳定的 resize、overlay、splitter 与 focus behavior；它应换 tokens，不应重写交互。
- 全局 `button`、`input` 规则会绕过共享组件，也容易让新控件意外继承错误尺寸、边框和字体。
- 只有 Workspace onboarding 的主按钮开始使用共享 `Button`；其余 toolbar、sidebar、composer、alerts、menus 与 forms 仍各自实现。
- Radius、shadow、surface、status color 和 type size 仍有不少局部硬编码，Storybook 改 token 不能完整传播到 Desktop。
- `profile-menu-popover`、inspector controls、status surfaces 等在重复实现已由 shadcn/Radix 解决的 interaction/presentation boundary。
- Desktop 的品牌层目前只有共享 logo；Atmospheric Paper 还没有进入 shell 的统一 surface hierarchy。
- 当前 CSS 仍有一组 legacy `prefers-color-scheme: dark` palette；它不是本轮已确认的 Hatch design，不能被误认为已经存在的 Dark Mode。

## 不可改变的边界

本项目不是 Desktop UX 重构。以下变化一律不进入本计划：

- 不改变 DOM 的业务层级、command 名称、event handler、state shape、API 调用、Runtime protocol 或持久化格式。
- 不改变 Agent → Conversation → Run 的层级，不增加或删除任何操作。
- 不用 Dialog 代替 native menu，不用 Web 控件重画 traffic lights、file picker、system menu 或 OS notification。
- 不改变 composer 的 submit、stop、IME、attachment、Workspace 或 permission 行为。
- 不改变 pane collapse 阈值、resize、focus trap、keyboard splitter、window zoom 或 scroll ownership。
- 不在产品入口加入 Storybook fixture、demo state、假 Agent、假 Conversation 或假成功状态。
- 不做 Dark Mode。改版后的 Hatch renderer 固定为已确认的 light design；OS 原生菜单、picker、notification 仍由系统负责。未来 dark palette 必须另立设计与验收范围。

## 共享资产契约

### Logo

- 唯一源文件：`packages/brand/hatch-mark.svg`。
- React 使用 `HatchBrand`；只需要图片 URL 的 Native/auxiliary surface 使用 `hatchMarkUrl`。
- Desktop 不复制 SVG，不把 logo 重新画进 CSS，也不生成独立平台版本。

### Atmospheric Paper gradient

- 唯一配方由 `AtmosphericPaper` 渲染；`packages/brand/tokens.css` 提供 base、warm field、cool field、strength、blur 与 duration 参数。
- 唯一渲染 primitive 是 `AtmosphericPaper`；页面不得自行拼第二套 radial gradient。
- Desktop shell 只允许一个 atmosphere owner。Toolbar、Sidebar、Main 和 Inspector 通过透明度与 surface token 接收同一环境光，不分别绘制 gradient。
- 不出现有边界的 gradient square，不在 nav/toolbar 边缘做 gradient line，不以大面积 glow 代替层级。
- Working surface 默认使用低于 marketing/Creator Studio 的强度；welcome/auth 可以使用标准强度。
- `prefers-reduced-motion` 下停止位移，保留静态材质；不通过 JS animation timer 模拟 motion。

## 组件迁移矩阵

| Desktop 现有 surface | 目标实现 | 功能要求 |
| --- | --- | --- |
| Global `button` / `.secondary` / `.compact` | `Button`、`IconButton` | 原 handler、disabled、aria-label、Send/Stop contract 不变 |
| Sign-in / Workspace fields | `Input`、`FormField`、`Button` | auth 与 grant 调用不变 |
| Profile popover | `DropdownMenu` | Settings、Sign out、focus return 与 keyboard path 不变 |
| Sidebar rows | Desktop `SourceRow`，消费 shared tokens | 保留 Agent disclosure、rename input、context menu 与 ellipsis |
| Toolbar chrome buttons | shared `IconButton` 的 desktop density adapter | 保留 drag/no-drag、aria-controls、native overflow |
| Connection/status copy | `StatusTag` 或安静的 inline status | 只有真正的 label 使用 pill，不增加 mini-heading |
| Recovery/error/notice | `InlineAlert` | role、retry、dismiss 和真实错误文案不变 |
| Inspector permission control | 优先保留 native `select`，用 shared field tokens | 不为视觉一致性重写成熟 native interaction |
| Pane overlay | 保留 `PaneOverlay` behavior，复用 `Sheet` 的 surface tokens | focus trap、Escape、scrim 与 opener focus 不变 |
| Composer shell | Desktop `ComposerSurface`，消费 shared tokens | Assistant UI 与 Tauri wiring 完全不动 |
| Attachment chip | shared pill/label typography + Desktop attachment behavior | remove action、filename overflow 与 native handle 不变 |
| Tool/skill activity、approval | Desktop product components + shared feedback/button primitives | timeline order、streaming、approval authority 不变 |
| Markdown | 保留 Desktop editorial renderer | table/code 局部 overflow、selection 与 measured rhythm 不变 |
| Welcome/auth/empty/auxiliary windows | `HatchBrand` + shared forms/feedback + `AtmosphericPaper` | 所有真实 bootstrap/auth/error 分支不变 |

Date picker 不纳入共享自绘组件；若 Desktop 未来需要日期输入，使用平台/native HTML 能力，除非产品需求证明需要新的 interaction。

## 视觉规则

### Typography

Typography 的唯一实现链路是：

`设计规范（语义） → packages/brand/tokens.css（数值） → @hatch/ui（组件实现） → Web / Desktop / Storybook（消费者）`

设计规范是人的契约，不是运行时变量；`@hatch/ui` 是组件 reference implementation，不能把它的 CSS 复制到产品里。新增字号角色时，必须先更新规范和 brand token，再由 HUI 与产品消费者使用；不得为了兼容旧 CSS 保留未批准的局部字号。

Web 页面自己的 layout CSS 也只能消费这些 semantic tokens；它可以定义页面组合和响应式关系，但不能再建立第二套局部字号数值。Storybook 的 fixture 可以调节 token，但不能复制 HUI primitive 的实现。

共享字号使用 `rem`：

| Token | Value | 用途 |
| --- | ---: | --- |
| `--hatch-type-micro` | 0.625rem | 仅键盘提示、密集计数等刻意压缩的元信息 |
| `--hatch-type-caption` | 0.6875rem | 次要元信息、脚注、时间戳 |
| `--hatch-type-label` | 0.75rem | label、pill、status、导航、表头、头像 initials |
| `--hatch-type-control` | 0.8125rem | button、select、form control |
| `--hatch-type-body` | 0.875rem | 普通 UI 正文 |
| `--hatch-type-reading` | 0.9375rem | Desktop transcript/editorial reading |
| `--hatch-type-emphasis` | 1rem | 强调正文 |
| `--hatch-type-subheading` | 1.125rem | 内容小标题 |
| `--hatch-type-subtitle` | 1.25rem | 次级标题 |
| `--hatch-type-heading` | 1.5rem | 内容标题 |
| `--hatch-type-title` | 1.75rem | 页面和组件标题 |
| `--hatch-type-display-compact` | 2rem | 紧凑 display |
| `--hatch-type-display` | 2.25rem | 主 display |
| `--hatch-type-display-hero` | 4rem | 欢迎页/hero display 上限 |
| `--hatch-type-code` | 0.8125rem | code 内容 |

`em` 只用于组件内部需要相对父级的局部关系；`line-height` 使用无单位数字；边框、icon 和窗口几何才使用 `px`。

- Instrument Serif 只用于真正的 display title、欢迎语、内容标题和有意义的 editorial heading。
- UI 操作与正文使用 macOS system sans；Windows 使用对应 system sans fallback。
- Pill、badge、status label 使用 Inter，字重与字面宽度由共享 token 控制。
- Label 可以存在；不为了“品牌感”添加解释性 mini-heading。
- Mono 只保留在 code、command、log、identifier 等内容语义中，不作为普通 UI 装饰字体。

### Shape、material 与 contrast

- 所有圆角对称；取消单个角不同 radius 的造型。
- 少做 card：Sidebar、Transcript、Inspector 主要通过 surface 明度、间距和分隔建立层级。
- 不模仿收据、订单、书页或其他商业物件；只模拟吸光、遮挡、色温、柔和 seam 与层级。
- Primary button 必须保持明确的 ink-level contrast，不用浅 terracotta 作为默认主操作。
- 正文、secondary text、placeholder、disabled、status 与 focus state 均使用 token；不得为了“atmosphere”牺牲 legibility。
- 普通 primitive 保持安静。品牌识别来自整体比例、排版、固定 logo、ambient field 和少量 pigment state，不要求每个 checkbox 自己有灵魂。

## 实施阶段

### Phase 0 — 冻结行为契约

1. 为当前真实 renderer 记录 component/state inventory，不改业务实现。
2. 把现有 renderer、layout、native command、auth、conversation、workspace 与 activity behavior tests 作为 migration gate。
3. 旧 `desktop-style-contract` 中要求 renderer 自动采用 dark palette 的视觉断言应替换为 light-only token contract；这是设计契约更新，不得借机改动任何产品 handler、state、Native bridge 或 accessibility behavior。
4. 在 Storybook 创建 Desktop visual-only stories；fixtures 只能留在 Storybook，名称必须明确标注 component playground。

### Phase 1 — Token 接管

1. 将 Desktop 的 `surface-window/sidebar/toolbar/inspector`、border、focus、type scale、radius 和 shadow 映射到 `packages/brand/tokens.css`。
2. 删除重复 token 值，但暂时保留现有 class 与 DOM。
3. 把全局 element rules 收窄到 reset；具体呈现由 shared component 或明确的 Desktop component class 拥有。
4. 建立 `desktop-density` adapter，只调整紧凑高度和 pane spacing，不复制 color/radius/shadow system。

### Phase 2 — Primitive 迁移

按风险从低到高替换：

1. Welcome/Auth/Workspace/Empty/Error 的 Button、Input、InlineAlert、HatchBrand。
2. Sidebar footer menu、toolbar IconButton、Inspector fields、status labels。
3. Recovery banner、attachment pill、approval actions。
4. Pane overlay 只迁移 surface/motion tokens；现有 focus/resize behavior 保留。

每次替换只允许 presentation diff；handler、props、aria、state 和 native command 必须逐项对照。

### Phase 3 — Desktop product surfaces

1. 从 `main.jsx` 抽出纯 view components：`DesktopSidebar`、`ConversationToolbar`、`Inspector`、`ComposerSurface`、`ActivityTimeline`、`StartupSurface`。
2. 不移动数据 fetching、Runtime lifecycle 或 Native bridge authority；容器继续从当前 `App` 注入真实 state 和 callbacks。
3. Transcript 与 Markdown 建立独立 style module，避免被 generic card/form rules污染。
4. Composer、tool activity 与 approval 采用同一 surface hierarchy，但不把它们变成通用 dashboard cards。

### Phase 4 — Atmosphere 接入

1. Welcome/Auth 使用一个标准 `AtmosphericPaper` root。
2. 主工作窗口使用一个低强度 root；Transcript 保持高可读性 matte surface。
3. Sidebar/Inspector 只通过 translucent shared surfaces 接收环境色，不各画 gradient。
4. 验证 paused/reduced-motion、窗口 resize、WebView performance 与文字 contrast。

### Phase 5 — Storybook GUI

在现有 Theme Lab 之外增加以下 Desktop stories：

- Toolbar：regular、connecting、retry exhausted、long titles。
- Sidebar：multiple Agents、empty Library、rename、selected、long names。
- Inspector：workspace granted/unavailable、permission variants。
- Composer：empty、attachments、running/stop、disabled/offline、long filename。
- Transcript：user、assistant streaming、Markdown、table、code、tool activity、approval、error。
- Shell：regular、compact、minimal、sidebar overlay、inspector overlay。
- Startup：launch、sign in、network error、unsupported role、empty Agents、workspace onboarding。

Controls 至少暴露 density、type scale、primary color、canvas color、radius、atmosphere strength 和 motion。GUI 调节读取的仍是共享 tokens，不创建 Desktop 专属颜色副本。

### Phase 6 — 验证与 UAT

自动验证：

- `npm run test:renderer`
- `npm run build:web`
- Storybook static build 与 accessibility check
- Web dashboard unit/build，防止 shared package 回归
- `git diff --check`

真实产品 UAT 必须在正式 Tauri product build 与真实 integration path 上完成，并与 Storybook visual check 分开记录：

- macOS 与 Windows 在 light renderer 下的 regular/compact/minimal resize、zoom、focus、IME、Reduced Motion、Increase Contrast；OS 切到 dark appearance 时仍保持 Hatch light palette 与清楚的 native boundary。
- 真实 sign-in、entitlement、Conversation list/create/select/rename/archive。
- 真实 Runtime streaming、cancel、reconnect、tool activity 与 approval。
- 真实 Workspace picker、file drop、native menu、Settings/About、多窗口与恢复。
- Background-off test：关闭 atmosphere 后，仍通过 typography、spacing、surface hierarchy、logo 和 pigment state 识别 Hatch。
- Grayscale test：去色后，信息层级、primary action、focus 与 error/success 仍清楚。

缺少真实服务、账号、签名 build 或目标 OS 时，对应项标记为未验收；不得用 Storybook fixture 或 static preview 替代。

## 完成定义

- Web、Desktop、Storybook 都从 `@hatch/ui` 消费同一套固定 logo、gradient recipe、tokens 和 primitives。
- 修改 shared token 能同时影响三端；Desktop 没有第二份品牌 palette、radius 或 shadow system。
- Desktop 的所有既有功能、快捷键、focus、Native boundary、state、API 与 persistence tests 保持通过。
- 组件即使关闭 gradient 背景也不退化成随意的 beige shadcn collection。
- Storybook 是可编辑的视觉工作台，但不进入产品 runtime，也不作为真实产品 UAT 证据。
