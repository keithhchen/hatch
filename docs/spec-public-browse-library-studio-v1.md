# Hatch Public Browse, Library & Studio v1

> Historical UX baseline. Route and identity examples in this document predate the UUID cutover; use [UUID Product Identity v1](./spec-uuid-product-identity-v1.md) and [Web Dashboard & Commerce Flow v2](./spec-web-dashboard-commerce-v2.md) for the implemented canonical surface. No legacy route redirect is supported.

状态：Product / UX / Web routing contract

日期：2026-08-12

优先级：本规格覆盖 `spec-web-dashboard-commerce-v2.md` 中关于 Public、Portal、Buyer route、Creator route、Caddy 和 free acquisition 的旧命名与路径。Commerce 的订单、Entitlement、Delivery、幂等、隐私和审计约束继续沿用原规格。

## 1. 产品结论

Hatch Web 不是一个以 Portal 为中心的后台。它由四个用户能直接理解的空间组成：

1. **Explore**：公开 Browse；无需登录。
2. **Library**：用户已经获得的 Creator products；需要登录。
3. **Orders**：领取记录、Receipt、Entitlement 与 Delivery；需要登录。
4. **Studio**：Creator 创建、发布和经营产品；需要 Creator 身份。

`Portal`、`Dashboard` 和 `My Agents` 不再作为顶层产品名称或 URL namespace。

核心边界：

> Browse 和分享无需登录；免费领取、使用、订单恢复和经营管理时才登录。

本阶段只上线真实的免费领取。付费、订阅和 payout transfer 不得以 mock success 或不可用 CTA 出现在 production 主链。

## 2. North Star journeys

### 2.1 Visitor / Buyer

```text
Explore
→ Creator
→ Product
→ Get for free
→ Sign in / Sign up（仅此时）
→ Confirm free order
→ Receipt
→ View in Library / Open Desktop / Download
→ Order、Entitlement、Delivery detail
```

### 2.2 Creator

```text
Studio
→ Factory autosave
→ Candidate review
→ Approve
→ Free offer
→ Public page preview
→ Publish
→ Copy public link
→ Orders / Delivery
→ Honest payout unavailable state
```

## 3. Information architecture

### 3.1 Public routes

| Route | 登录 | 页面 | 主动作 |
| --- | --- | --- | --- |
| `/` | 不需要 | Explore 首页；等同 canonical `/explore` | Browse products |
| `/explore` | 不需要 | 浏览全部已发布 products | View product |
| `/creators/:creatorSlug` | 不需要 | Creator public profile 与 products | View product |
| `/creators/:creatorSlug/:productSlug` | 不需要 | Public product detail | Get for free / View in Library |
| `/sign-in?returnTo=…` | 匿名 | 登录并恢复原意图 | Sign in |
| `/sign-up?returnTo=…` | 匿名 | 注册并恢复原意图 | Create account |

Public breadcrumb：

```text
Explore > Creator display name > Product name
```

路径中不加入 `/agents`。Product 是否由 Agent 驱动属于实现与品类信息，不需要成为 URL 层级。

### 3.2 Library routes

| Route | 登录 | 页面 | 主动作 |
| --- | --- | --- | --- |
| `/library` | Buyer | 已拥有、可使用、已耗尽或已撤销的 products | View product |
| `/library/:creatorSlug/:productSlug` | Buyer | 用户拥有的 product access | Open Desktop |

Library detail 必须包含：

- product 与 Creator；
- access status；
- purchased release 与 effective release；
- included、remaining、reserved units；
- valid from / valid until；
- Delivery history；
- Order link；
- Open Desktop / Download；
- access unavailable 时的明确原因与支持 reference。

### 3.3 Order routes

| Route | 登录 | 页面 | 主动作 |
| --- | --- | --- | --- |
| `/orders` | Buyer | 完整领取与订单历史 | View receipt |
| `/orders/:orderNumber` | Buyer | Receipt、access 与 Delivery timeline | View in Library |
| `/orders/:orderNumber/success` | Buyer | 可恢复的领取成功页 | View in Library |

`orderNumber` 是稳定、可读、不可猜出其他用户信息的公开显示编号，例如 `HCH-2026-000123`。内部仍以 UUID `order_id` 作为 authority；BFF 负责安全解析 display number。

### 3.4 Studio routes

| Route | 身份 | 页面 |
| --- | --- | --- |
| `/studio` | Creator | 经营概览与下一步 |
| `/studio/factory` | Creator | Factory runs |
| `/studio/factory/:runId` | Creator | 可刷新、可恢复的单个 run |
| `/studio/products` | Creator | Products |
| `/studio/products/:productId` | Creator | Product overview |
| `/studio/products/:productId/candidates/:candidateId` | Creator | Candidate review |
| `/studio/products/:productId/offer` | Creator | Free offer |
| `/studio/products/:productId/preview` | Creator | 与 public page 同组件的 preview |
| `/studio/products/:productId/releases/:releaseId` | Creator | Immutable release / rollback |
| `/studio/orders` | Creator | Orders / Delivery operations |
| `/studio/orders/:orderNumber` | Creator | Privacy-safe order timeline |
| `/studio/payouts` | Creator | Honest payout state |

### 3.5 Account route

| Route | 登录 | 页面 |
| --- | --- | --- |
| `/account` | Account | Profile、session、security、sign out、help |

## 4. Identity、UUID、slug 与 URL

### 4.1 Authority IDs

每个资源必须有不可变 authority ID：

- `creator_id`：UUID；
- `product_id`：UUID；
- `public_id`：UUID，绑定公开 product identity；
- `order_id`：UUID；
- `entitlement_id`：UUID；
- `factory_run_id`、`candidate_id`、`release_id`：不可变 ID。

React component key、数组下标、当前 tab 或 Creator/product 名称都不能充当资源身份。

### 4.2 Public slugs

- Creator 和 Product 各有唯一 slug。
- Public canonical URL 使用可读 slug：`/creators/:creatorSlug/:productSlug`。
- Slug 是 presentation，不是 authority。
- 改名不自动改 slug。
- Creator 明确修改 slug 时，旧 slug 必须保留 alias，并 308 到新 canonical URL。
- Alias 不得转移给其他 Creator 或 Product。
- API、订单快照和 Entitlement 始终保存 UUID，不只保存 slug。

### 4.3 Private readable routes

- Library 使用同一组 Creator/Product slug，便于用户识别。
- Order 使用 display `orderNumber`。
- Studio 可以使用 UUID，因为它是经营工具；UI 仍显示产品名而非裸 ID。
- BFF 必须先按当前 Account scope 查找 private resource；不能通过顺序 UUID 或 display number枚举他人数据。

## 5. Public Browse specification

### 5.1 Explore

Explore 首屏必须在匿名状态下展示真实 published products，不出现登录墙。

每张 product card 至少展示：

- Creator name 与 verified state；
- Product name；
- 一句话 outcome / promise；
- 关键 input 与 output；
- Free；
- `View product` 链接。

加载中、无产品、请求失败必须是三种不同状态。请求失败不能渲染为 “No products”。

### 5.2 Creator public page

Creator page 展示：

- display name、avatar/mark、verified state；
- 简短 public bio；
- published products；
- 不展示 protected Corpus、Buyer、order 或 revenue 数据。

### 5.3 Product public page

匿名用户必须看到完整购买决策信息：

- Creator identity；
- Product name 与 outcome；
- What you provide；
- What you receive；
- boundaries / not included；
- example outputs（如有且公开）；
- delivery unit；
- refund/cancellation policy；
- compatible Desktop / download requirements；
- active free offer；
- published version / updated time；
- 主 CTA。

主 CTA 状态：

| Visitor state | CTA | 行为 |
| --- | --- | --- |
| Anonymous | `Get for free` | 进入 sign-in/sign-up，保存 intent |
| Signed in, not owned | `Get for free` | 创建 checkout intent |
| Signed in, owned | `View in Library` | 链接到 Library detail；不可 disabled |
| Creator owns product | Buyer CTA + secondary `Manage in Studio` | 保留真实 Buyer 视角 |
| Withdrawn/unavailable | `Unavailable` | 无 mutation；解释原因 |

`View in Library` 必须是 `<a>` 或等效 router link，支持复制、Open in new tab、键盘和 browser status bar。

## 6. Authentication and free acquisition

### 6.1 Login boundary

以下行为不要求登录：

- 打开 `/`、`/explore`；
- 打开 Creator/Product link；
- 搜索、过滤、前进、后退、刷新；
- 读取 public metadata；
- 复制分享链接。

以下行为要求登录：

- Get for free；
- Library、Orders、Account；
- Open Desktop 的 account-bound access；
- Studio。

### 6.2 Intent preservation

匿名用户点击 `Get for free` 时，Web 创建或保留一个非权威 acquisition intent：

```json
{
  "public_id": "uuid",
  "offer_id": "uuid",
  "return_to": "/creators/seth/alpha-lite"
}
```

规则：

- `returnTo` 只接受站内 allowlist path；
- 客户端不传价格、release digest、Creator authority ID 或 included units；
- 登录/注册完成后回到同一 product intent；
- Offer 已变化时显示 diff，要求重新确认；
- intent 过期时回到最新 public product，不静默下单。

### 6.3 Free checkout

确认页明确显示：

- Product / Creator；
- `Free`；
- `Payment: Not required`；
- included delivery units；
- release/version policy；
- cancellation policy；
- `Add to Library` 主 CTA。

确认成功必须原子创建一个 Order 与一个 Entitlement。重复提交、网络丢响应和刷新只能产生同一结果。

### 6.4 Success

成功不是 toast。`/orders/:orderNumber/success` 是可刷新页面，包含：

- `Added to your Library`；
- Order number；
- access status；
- `View in Library` 主 CTA；
- `Open Desktop` / `Download` 次动作；
- access projection 正在同步时的 honest pending state 和 retry。

## 7. Library behavior

- Library 是“我拥有和使用的产品”，不是公开 Browse 的复制。
- Product withdrawn 后，已有用户仍能查看 purchase snapshot；能否继续使用由 Entitlement 决定。
- remaining units 为 0 时显示 `Used`，不显示 generic unavailable。
- revoked/cancelled 时禁用运行，但 Receipt 仍可读。
- Library card 与 detail 均是 link，不使用不可点击的 status button 替代导航。
- Open Desktop 使用明确的 app/deep-link contract；不可用时提供 Download 和 setup help。

## 8. Orders behavior

- Orders 包含免费领取；免费订单不是 Payment success。
- 列表完整分页，不只显示最近五条。
- Receipt 必须保存当时的 Product、Creator、Offer、Release 与 policy snapshot。
- Order detail 显示 Order、Entitlement 与 Delivery 的独立状态。
- 免费、未 Delivery 的订单可取消并撤销 access；操作幂等。
- 已撤销 access 的已连接 Runtime session 下一次运行必须 fail closed。

## 9. Studio behavior

- Factory draft server autosave；刷新和跨 tab stale write 均安全。
- Candidate review 显示 evidence、critical gates、known losses、Corpus/report digest。
- Approve、Offer、Publish 是三个独立 mutation。
- Preview 与 public page 共用 presentation component 和 normalization model。
- Publish 完成后展示并可复制 `/creators/:creatorSlug/:productSlug`。
- Publish/rollback 不改变 public identity 和 canonical URL。
- Creator Orders 不包含 Buyer Workspace、conversation、文件 path 或 artifact content。
- 免费阶段 Payout 显示明确 `Not available for free orders`；不展示假余额或 Connect 成功。

## 10. Global navigation

Anonymous：

```text
Hatch | Explore | Sign in
```

Signed-in Buyer：

```text
Hatch | Explore | Library | Orders | Account
```

Creator：

```text
Hatch | Explore | Library | Orders | Studio | Account
```

移动端必须保留 Account 与 Sign out 的可达入口。当前 route 对应导航项具有 `aria-current="page"`。

## 11. Routing and rendering contract

### 11.1 Route-addressable application

使用 SPA 技术是允许的，但每个页面必须是 addressable resource：

- 地址栏随页面变化；
- direct GET 返回 200/3xx/4xx 的正确语义；
- refresh 恢复同一页面；
- Back/Forward 正常；
- Open in new tab 正常；
- copy link 正常；
- 页面不依赖上一个 React memory state 才能存在。

### 11.2 Public HTML and metadata

`GET /creators/:creatorSlug/:productSlug` 在没有 Cookie、没有 JavaScript 时必须返回：

- product-specific `<title>`；
- meta description；
- canonical URL；
- Open Graph / Twitter metadata；
- 真实 404 或 unavailable metadata；
- 不包含 private fields。

可以由 BFF 注入 HTML metadata，也可以 SSR；不能只在 hydration 后修改 `document.title`。

### 11.3 Route focus

- Route 完成加载后，焦点进入页面 `h1`。
- Async page 必须在内容 ready 后聚焦，不能只在 pathname 改变的首帧查找不存在的 `h1`。
- Skip navigation 在 focus 状态满足 WCAG AA。

## 12. Caddy contract

### 12.1 Routing order

Caddy 的匹配优先级必须是：

1. health/readiness；
2. Runtime WebSocket / internal service route；
3. `/v1/*` → Dashboard BFF；
4. public/private Web routes → Dashboard server；
5. assets；
6. legacy redirects；
7. 404。

不得将 `/v1/auth/me` 或 Creator Web API 优先转发给 Registry，避免绕过 BFF 的 HttpOnly Cookie session。

### 12.2 Required route behavior

| Incoming path | Caddy behavior |
| --- | --- |
| `/` | Dashboard Explore；不重定向 `/portal/` |
| `/explore` | Dashboard public route |
| `/creators/*` | Dashboard server route；保留 path 与 query |
| `/library/*` | Dashboard route；未登录由应用带 returnTo 跳 sign-in |
| `/orders/*` | Dashboard route；同上 |
| `/studio/*` | Dashboard route；Creator authorization |
| `/account` | Dashboard route |
| `/sign-in`, `/sign-up` | Dashboard auth route |
| `/v1/*` | Dashboard BFF |
| `/runtime*` | Runtime/WebSocket contract |
| `/assets/*` | immutable static assets |

Private Web route 不由 Caddy 自己判断 Cookie 身份；BFF/application 负责一致的 auth、returnTo 与 401/403 UX。

### 12.3 Legacy migration redirects

旧链接必须做精确 migration，不做一条笼统的 `/portal/* → /`：

| Legacy | New |
| --- | --- |
| `/portal/` | `/explore` |
| `/portal/agents/:creator/:product` | `/creators/:creator/:product` |
| `/portal/library`、`/portal/my-agents` | `/library` |
| `/portal/library/:entitlementId` | BFF 查询后 308 到 `/library/:creator/:product` |
| `/portal/orders` | `/orders` |
| `/portal/orders/:orderId` | BFF 查询后 308 到 `/orders/:orderNumber` |
| `/portal/creator/*` | 对应 `/studio/*` |
| `/portal/settings` | `/account` |

需要资源查询的 redirect 由 Dashboard server 执行，不由 Caddy 猜测 ID/slug。

### 12.4 Caddy negative requirements

- 不把所有未知路径都 200 到同一空 SPA shell；
- 不把 `/` 308 到 `/portal/`；
- 不丢 query string；
- 不重写 canonical public path；
- 不公开 Registry internal access/deployment endpoints；
- 不缓存带 Account private data 的 HTML/API；
- 不让 public page metadata 依赖浏览器 Cookie。

## 13. API surface

最小 Web API：

```text
GET  /v1/public/products
GET  /v1/public/creators/:creatorSlug
GET  /v1/public/creators/:creatorSlug/products/:productSlug

POST /v1/auth/sign-in
POST /v1/auth/sign-up
POST /v1/auth/sign-out
GET  /v1/auth/me

POST /v1/checkout-sessions
GET  /v1/checkout-sessions/:checkoutSessionId
POST /v1/checkout-sessions/:checkoutSessionId/confirm

GET  /v1/library
GET  /v1/library/:creatorSlug/:productSlug
GET  /v1/orders
GET  /v1/orders/:orderNumber
POST /v1/orders/:orderNumber/cancel

GET  /v1/studio/...
```

Public lookup 先解析 alias，再返回 canonical slug。Private lookup 必须在 Account scope 内完成。

所有 mutation：

- 要求 `Idempotency-Key`；
- 同 key 同 payload replay；
- 同 key 不同 payload 返回 409；
- 返回 stable `request_id`；
- 客户端不提交权威 price/release/access scope。

## 14. State and error UX

| State | Required UX |
| --- | --- |
| Loading | Skeleton/progress；不显示 empty |
| Anonymous public | 完整内容与 Get for free |
| 401 private | Sign in + exact returnTo |
| 403 | 无权访问；不伪装 404，除非安全策略要求 |
| 404 | Resource not found + Explore link |
| Withdrawn | Public unavailable；已有 Buyer 可看 snapshot |
| Offer changed | old/new diff；重新确认；零副作用 |
| Access syncing | Order confirmed；setting up access；可安全 retry |
| Offline | 保留页面和重试，不清空为 empty |
| Revoked | Receipt 可读，Runtime fail closed |

## 15. Security and privacy

- Public response 仅输出 explicitly public presentation fields。
- Browser 使用 HttpOnly、Secure、SameSite Cookie；不把 Desktop bearer 复制进 Web session。
- Mutation 使用 CSRF 与 same-origin validation。
- Registry internal grant、deployment 和 Runtime endpoints 不经 public Caddy route 暴露。
- Public UUID 不提供 private resource access。
- Slug lookup、orderNumber lookup 与 redirect 都必须 Account-scoped 或 public-safe。
- Logs、telemetry、Commerce events 不包含 Buyer content、local path、artifact body、auth token 或 provider secret。

## 16. Analytics

允许的 privacy-safe funnel：

```text
explore_viewed
creator_viewed
product_viewed
get_free_clicked
auth_started
auth_completed
checkout_started
free_order_confirmed
library_viewed
desktop_open_clicked
delivery_recorded
public_link_copied
```

属性只允许 public/resource IDs、route template、status、viewport class 与 request correlation；不记录 email、名字、query 文本、Workspace 内容或完整 URL query。

## 17. Responsive and accessibility

验收 viewport：320、390、768、1280 px。

必须满足：

- 无水平溢出；
- 主 CTA 至少 44×44 CSS px；
- mobile CTA 不遮挡内容或 Account；
- 所有链接具有 link semantics；
- keyboard-only 可完成 Browse → auth → free order → Library；
- focus、contrast、label、error summary 满足 WCAG 2.2 AA；
- product card、breadcrumb、navigation、dialog 与 status 具有正确语义。

## 18. Migration and rollout

### Phase A — Route foundation

- 新 route map 与 resource resolver；
- UUID/public ID、slug、alias 与 orderNumber；
- Caddy 停止 `/ → /portal/`；
- legacy redirects；
- public metadata direct-GET tests。

### Phase B — Public Browse

- `/explore`；
- Creator page；
- Product page；
- anonymous access；
- share/copy；
- responsive/a11y。

### Phase C — Free acquisition

- returnTo；
- free checkout；
- receipt；
- Library；
- Orders；
- `View in Library` link；
- Runtime access enforcement。

### Phase D — Studio migration

- Studio routes；
- publish emits canonical public URL；
- Factory and Candidate deep links；
- Creator Orders；
- honest payout state。

Production route switch 只有在新链接 direct GET、Browser navigation、Caddy、auth returnTo 和 legacy redirects 全部通过后才执行。

## 19. Acceptance matrix

1. 未登录的新浏览器直接打开 `/creators/seth/alpha-lite`，得到 200、真实内容和 product metadata。
2. 禁用 JavaScript后，同一 URL 仍具有正确 title、description、canonical 和 OG。
3. 从外部页面打开、刷新、Back、Forward、Open in new tab 均保持同一 product。
4. Anonymous Explore、Creator、Product 不产生 auth redirect。
5. 点击 Get for free 才进入 auth；登录后回到同一 product/offer intent。
6. 重复 confirm 与丢响应 retry 只产生一个 Order 和一个 Entitlement。
7. Success 刷新后仍可恢复。
8. Owned product CTA 是可点击的 `View in Library` link。
9. `/library/seth/alpha-lite` 刷新后展示同一 Entitlement 和 Delivery history。
10. `/orders/HCH-…` 只能由所属 Account 访问。
11. 发布新 release 后 public URL 不变；旧订单 snapshot 不变。
12. 撤销 free order 后已连接与新连接 Runtime 均拒绝运行。
13. `/` 不再跳 `/portal/`。
14. 所有 legacy `/portal/*` 按映射跳到新 route，不丢 query/intent。
15. Caddy 不公开 Registry grant/deployment API，且 `/v1/auth/me` 经过 Dashboard BFF。
16. Creator 从 Studio publish 后复制的链接可在匿名浏览器打开。
17. 320/390/768/1280、keyboard 和 Axe 全绿。
18. Production smoke 使用真实域名验证 Explore、public product、auth returnTo、Library、Order 与 Studio deep link。

## 20. Definition of Done

只有同时满足以下条件才可称完成：

- 生产域名存在一个无需登录即可打开的真实 public product link；
- URL、UUID authority、slug alias 与 canonical metadata 均成立；
- Browse 与 private application 不再以 `/portal` 混在同一信息架构；
- `View in Library` 可点击并进入稳定 route；
- Free acquisition、Receipt、Library、Order 与 Runtime access 是同一真实闭环；
- Caddy、BFF、Registry 和 Runtime 的路由/授权边界通过 negative tests；
- legacy links 有明确迁移行为；
- 本地测试、Browser E2E、container build、remote CI 和 production smoke 全绿。

“代码在 PR 中可运行”或“打开 `/portal/` 后可以点到页面”都不构成交付完成。
