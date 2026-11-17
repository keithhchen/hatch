# Hatch Web、Desktop 与 Open Access 规范

状态：Current
取代：旧 Web Dashboard / Commerce V2 中的 Offer、active offer、pricing workflow 设计
范围：公开浏览、Creator 发布、Open Access、My library、Desktop、Runtime

## 1. 产品规则

Hatch 是 Open Access：没有购买、结账、订阅或确认步骤，任何人（含未登录的访客）都可以和任何 live Agent 对话。

- Product 未发布：不可公开浏览，也不可对话。
- Product 已发布：任何人可公开浏览并直接对话；Studio 里关闭 listing 的 Agent 只是不出现在列表，链接仍可用。
- Product withdrawn：停止新对话；历史 Run 保留。

“My library” 是账号在 Access ledger（`packages/commerce`）里的 active 免费 entitlement：账号第一次对某个 Agent 发起 Run 时由 Runtime 调 Dashboard 自动保存（`POST /v1/internal/library/save`），用户用 `DELETE /v1/library/{product_uuid}` 移除；移除不删除对话。Entitlement 不门控 chat。

当前不做付费、订阅、价格编辑或 payout 的购买入口。系统中没有 Offer、checkout session、order 管理或买家退款。

用户看到的完整链路是：

```text
公开 Product 或分享链接 → 直接对话（访客或登录账号）
→ 登录账号的 Run 自动进入 My library
```

Creator 的完整链路是：

```text
Factory autosave → Candidate review → Approve
→ Storefront preview → Publish → Share UUID URL
→ Studio Users（谁在用、对话与消息数）
```

## 2. 身份与 URL

所有 durable entity 使用数据库 UUID v4。Slug 不参与 identity、authorization、lookup 或 canonical URL。

```text
/creators/{creator_uuid}
/products/{product_uuid}
/library
/chat/product/{product_uuid}
/studio/products/{product_uuid}
```

`product_id` 同时是 Runtime 的 `agent_id`。Creator 与 Product 的关系由 Product 的 `creator_id` 建立。

公开 Creator 页必须列出该 Creator 当前 published Products。公开 Product 页必须把 Creator name 链接到 `/creators/{creator_uuid}`。公开页无需登录、可刷新、可分享，并在 server HTML 中提供 canonical、title、description 与 Open Graph metadata。

## 3. 唯一 source of truth

| 数据 | Authority |
| --- | --- |
| Account identity、session token | Registry |
| Creator、Product、Corpus release、current release | Registry |
| Factory draft、candidate、approval、publish/rollback workflow | Portal state |
| My library（active 免费 entitlement）、Creator 收益/payout 账务 | Access ledger（代码包历史名为 `packages/commerce`） |
| Conversation、run、artifact lifecycle | Runtime |

Registry 不保存、不返回、不投影用户 ownership。`agent_access` 是废弃数据，不能参与读取或授权。

Web、Desktop、Runtime 必须读取同一份 Access ledger：

- Web Library：`GET /v1/library` → Dashboard BFF → Access ledger。
- Desktop Library：`GET /v1/user/product-access` → Dashboard BFF → Access ledger。
- Runtime：Registry 只验证 bearer identity；Runtime 通过内部 Access API 列出资料库，并在 Run 开始时保存。

任何一边不可 fallback 到 Registry `agent_access`、fixture、local fake ID 或猜测的 Corpus digest。

## 4. Product 与 release

Product 是用户选择和对话的对象，最小字段：

```json
{
  "product_id": "uuid-v4",
  "creator_id": "uuid-v4",
  "name": "string",
  "description": "string",
  "promise": "string",
  "boundaries": ["string"],
  "presentation": {},
  "status": "published|withdrawn",
  "corpus_digest": "sha256:...",
  "release_id": "sha256:..."
}
```

每次 publish 生成 immutable release。Current release 影响公开浏览和新对话；Rollback 只切 current pointer，不改历史 Entitlement。

旧 immutable Corpus 中若仍含 `product.offer`，读取时必须丢弃该字段但保持原始 bytes 与 digest 不变。新 Corpus 不得再生成该字段。

## 5. 保存到 My library

Runtime 在登录账号开始 Run 时调用：

```http
POST /v1/internal/library/save   (service token)
{ "account_id": "uuid", "product_id": "uuid-v4" }
```

Dashboard 从 Registry 解析 published Product 和 current release，在 Access ledger 里创建一条 `unmetered`、`total_minor = 0`、`version_policy = pinned` 的免费 entitlement。同一 (account, product) 的并发保存只写一次；Creator 不能保存自己的 Agent（返回 `own_product`）。

移除（`DELETE /v1/library/{product_uuid}`）撤销该 entitlement；之后再次对话会再保存一份新的。

## 6. Entitlement contract

```json
{
  "entitlement_id": "uuid-v4",
  "order_id": "uuid-v4",
  "buyer_id": "uuid-v4",
  "creator_id": "uuid-v4",
  "product_id": "uuid-v4",
  "agent_id": "same-as-product-id",
  "status": "active|revoked|expired",
  "purchased_corpus_digest": "sha256:...",
  "effective_corpus_digest": "sha256:...",
  "version_policy": "pinned|track_current_compatible",
  "access_mode": "unmetered"
}
```

`order_id` 是库内部的免费 grant 记录，不对用户展示。字段缺失必须 fail closed，不能改用 current Corpus 猜测。

## 7. Desktop 与 Runtime

Desktop 使用 Registry opaque bearer：

1. `POST /v1/auth/signin`；
2. `GET /v1/auth/me`；
3. `GET /v1/user/product-access`。

前两个由 Registry 处理；第三个由 Dashboard 处理。Caddy 必须让 bearer-free OPTIONS preflight 到达正确 owner，并允许 Desktop WebView 使用 `Authorization`。

Runtime 与 Dashboard 之间只有两条内部 Access/Library 路由（service token，不经公网 Caddy）：

- `GET /v1/internal/access/users/{user_uuid}/entitlements`：列出资料库；
- `POST /v1/internal/library/save`：保存。

Runtime 不再 resolve 单个 Entitlement，不 reserve、不 consume、不生成 delivery 记录；Entitlement 也不决定能否对话。

## 8. Creator workflow

- Factory draft server autosave，带 version 与 idempotency key。
- Candidate approval绑定 candidate ID、Corpus digest、report digest 与 acknowledgements。
- Approval 后直接进入 storefront preview；没有定价步骤。
- Publish 校验 approval freshness，stage immutable Corpus，commit Portal release，再 CAS 激活 Registry current pointer。
- Share URL 固定为 `/products/{product_uuid}`；对话入口为 `/chat/product/{product_uuid}`。
- Rollback 要求 exact release、expected version 和 audit reason；失败可用同一 operation 重试。

Studio 的 Users 页（`/studio/users`，`GET /v1/creator/users`）展示谁在用：访客、账号、IM 联系人各自的对话数、消息数与首末时间，不展示 Workspace、对话内容或文件路径。Creator 收益与 payout 页面保持原样。

## 9. 数据迁移

部署时必须执行：

1. Portal persisted state 删除 `offer_snapshot`、`quote_change`、`offer_draft`、`offer_active`、operation 中的 offer fields；`offer_required` 映射为 `ready_to_preview`。
2. Registry `agent_access` 先精确备份再清空；之后没有产品代码读写它。
3. 已发布 Product 保持 published/current release，不因旧 Offer 缺失变 unavailable。
4. 既有 Entitlement 保留 UUID、release snapshot 与 Corpus digest，成为 My library；旧 unit/delivery 事件只作历史读取，不再改变 access 状态或出现在用户响应中。Portal persisted state 中的 `checkout_sessions` 在下一次写入时被丢弃。
5. 旧 Corpus 只做 read-time field stripping，不重写 content-addressed release。

迁移后，同一账号在 Web、Desktop、Runtime 看到的 active Entitlement ID 集合必须完全相同。

## 10. 安全与隐私

- Browser 使用 HttpOnly、Secure、SameSite cookie + CSRF；Desktop 使用 Registry opaque bearer，两者不互相复制。
- Creator 侧 mutation 要求 durable Idempotency-Key。
- Public Product 仅包含公开 presentation；用户 Workspace path/content、conversation、artifact body 不进入 Access ledger、Creator views、telemetry 或 logs。
- Runtime operational logs 只记录 allowlisted code/category，不输出 exception message、stack 或 private payload。
- Internal service token 不进入浏览器或 Desktop。

## 11. 验收门槛

上线前全部满足：

- unit：Dashboard、Access ledger、Runtime 全绿；
- 真实 Dashboard + Runtime：访客打开 `/chat/product/{id}` 能对话；登录账号的第一个 Run 之后 `/library` 列出该 Agent，移除后消失而对话保留；
- Studio Users 页对真实对话显示正确计数；
- Caddy/Compose config validation；
- 生产真实账号核对 Web、Desktop、Runtime 三边 library 的 Product IDs；
- 代码和产品响应中不存在 Offer、checkout、order 管理路由；仅允许 migration sanitizer 与明确的 negative test 出现旧名字。

## 12. 明确不做

- 购买/结账/订阅 UI、买家退款、按次数计量的 delivery；
- slug identity 或旧 URL 兼容；
- Registry ownership projection；
- 为缺失 release/digest/UUID 猜值；
- 用 fixture 或 mock 代替生产 UAT。

## 13. 免费聊与展示价格

- Expert 在 Studio Publish 页可选填三项，存于 `hatch_creator_products.pricing`（USD，金额为 minor units）：`free_messages`、`human_hourly_minor`、`agent_monthly_minor`。设置了 `free_messages` 时至少要有一个价格。
- 这些是展示条款，不是订单：Product 仍是 Open Access，不生成 offer 或 payment。
- `pricing` 是实时 Product 设置，不进 release snapshot；随公开 Product、`/v1/user/product-access` 的 `product` 和 Creator Product 视图返回。
- Runtime `GET /v1/conversations` 返回 `sent_message_count`（该账户对该 Product 的非 failed run 数）。`@hatch/chat` 的 `FreeChatMeter`（每个 Agent 一个，owner 不计量）同步该计数并在 accepted 时加一，共享 `ChatView` 在用完后用 `FreeChatPaywall` 替换输入框，Web 与 Desktop 同时阻止新对话；客户可选择一个选项，界面如实显示在线支付暂未开通。
- 当前只做前端拦截，Runtime 不拒绝超额消息。
