# Hatch Web、Desktop 与 Free Access 规范

状态：Current
取代：旧 Web Dashboard / Commerce V2 中的 Offer、active offer、pricing workflow 设计
范围：公开浏览、Creator 发布、免费领取、Entitlement、Desktop、Runtime

## 1. 产品规则

Hatch 当前只有一种商业状态：

- Product 未发布：不可公开浏览，也不可领取。
- Product 已发布：任何人可公开浏览；登录后可免费领取一次 delivery access。
- Product withdrawn：停止新领取；历史 receipt 和已有 Entitlement 保留。

当前不做付费、订阅、价格编辑或 payout。系统中没有 Offer、active offer、offer revision、not-for-sale，也不能因为旧数据缺少这些字段而把已发布 Product 判为 unavailable。

用户看到的完整链路是：

```text
公开 Product → 登录/注册 → 确认免费 access → Receipt
→ Library → Open Hatch Desktop → Runtime delivery
```

Creator 的完整链路是：

```text
Factory autosave → Candidate review → Approve
→ Storefront preview → Publish → Share UUID URL
→ Access records / Deliveries
```

## 2. 身份与 URL

所有 durable entity 使用数据库 UUID v4。Slug 不参与 identity、authorization、lookup 或 canonical URL。

```text
/creators/{creator_uuid}
/products/{product_uuid}
/library/{entitlement_uuid}
/orders/{order_uuid}
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
| Order、Entitlement、delivery units、delivery receipt | Access ledger（代码包历史名为 `packages/commerce`） |
| Conversation、run、artifact lifecycle | Runtime |

Registry 不保存、不返回、不投影用户 ownership。`agent_access` 是废弃数据，不能参与读取或授权。

Web、Desktop、Runtime 必须读取同一份 Access ledger：

- Web Library：Dashboard BFF → Access ledger。
- Desktop Library：`GET /v1/user/product-access` → Dashboard BFF → Access ledger。
- Runtime authorization：Registry 只验证 bearer identity；Runtime 再通过内部 Access API 查询 Entitlement。

任何一边不可 fallback 到 Registry `agent_access`、fixture、local fake ID 或猜测的 Corpus digest。

## 4. Product 与 release

Product 是用户选择和领取的对象，最小字段：

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

每次 publish 生成 immutable release。Current release 只影响后续公开浏览和新领取；已有 Entitlement 默认 pinned 到领取时的 `purchased_corpus_digest`。Rollback 只切 current pointer，不改历史 Order 或 Entitlement。

旧 immutable Corpus 中若仍含 `product.offer`，读取时必须丢弃该字段但保持原始 bytes 与 digest 不变。新 Corpus 不得再生成该字段。

## 5. 免费领取

### 5.1 Create checkout session

```http
POST /v1/checkout-sessions
Idempotency-Key: <buyer intent uuid>
Content-Type: application/json

{ "product_id": "uuid-v4" }
```

Server 从 Registry 解析 published Product 和 current release。Client 不提交 Creator ID、Corpus digest、金额或 entitlement scope。

Session snapshot 固定：

- buyer ID；
- Creator/Product UUID；
- current release ID 与 Corpus digest；
- `total_minor = 0`；
- `payment_status = not_required`；
- `included_units = 1`；
- `version_policy = pinned`。

### 5.2 Confirm

```http
POST /v1/checkout-sessions/{checkout_uuid}/confirm
Idempotency-Key: <confirmation intent uuid>
```

确认必须在同一个 Access transaction 中创建一个 Order 和一个 Entitlement。相同 key + 相同 payload 返回原结果；相同 key + 不同 payload 返回 409。

如果 Product 已 withdrawn 或 current release 已变化：

- 返回 `409 release_changed`；
- 旧 session 终止；
- 不创建 Order 或 Entitlement；
- 用户回到 Product 重新确认。

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
  "granted_units": 1,
  "remaining_units": 1,
  "reserved_units": 0
}
```

Runtime 只接受 active、UUID 完整、Order 完整、Creator/Product 匹配且包含 purchased/effective digest 的 binding。字段缺失必须 fail closed，不能改用 current Corpus 猜测。

## 7. Desktop 与 Runtime

Desktop 使用 Registry opaque bearer：

1. `POST /v1/auth/signin`；
2. `GET /v1/auth/me`；
3. `GET /v1/user/product-access`。

前两个由 Registry 处理；第三个由 Dashboard 处理。Caddy 必须让 bearer-free OPTIONS preflight 到达正确 owner，并允许 Desktop WebView 使用 `Authorization`。

Runtime session：

1. Runtime 向 Registry `/v1/auth/me` 验证用户 UUID；
2. Runtime 使用 service token 调 Dashboard：
   - `GET /v1/internal/access/users/{user_uuid}/entitlements`
   - `GET /v1/internal/access/entitlements/{entitlement_uuid}?user_id={user_uuid}`
3. Runtime 加载 exact `effective_corpus_digest`；
4. run 前 reserve 1 unit；失败/取消 release；成功 consume；
5. artifact 已保存后 accounting 暂时不可达时，turn 仍 completed，receipt 标 syncing，并由 durable outbox 重试。

内部 Access routes 不得经公网 Caddy 暴露。

## 8. Creator workflow

- Factory draft server autosave，带 version 与 idempotency key。
- Candidate approval绑定 candidate ID、Corpus digest、report digest 与 acknowledgements。
- Approval 后直接进入 storefront preview；没有定价步骤。
- Publish 校验 approval freshness，stage immutable Corpus，commit Portal release，再 CAS 激活 Registry current pointer。
- Share URL 固定为 `/products/{product_uuid}`。
- Rollback 要求 exact release、expected version 和 audit reason；失败可用同一 operation 重试。

Creator Orders 页面展示 Access record 与 delivery 状态，不展示价格、Offer 或 payout。付费能力以后若重启，应另写新规范与迁移，不得把旧 Offer 字段重新接回当前流程。

## 9. 数据迁移

部署时必须执行：

1. Portal persisted state 删除 `offer_snapshot`、`quote_change`、`offer_draft`、`offer_active`、operation 中的 offer fields；`offer_required` 映射为 `ready_to_preview`。
2. Registry `agent_access` 先精确备份再清空；之后没有产品代码读写它。
3. 已发布 Product 保持 published/current release，不因旧 Offer 缺失变 unavailable。
4. Order/Entitlement 保留 UUID、release snapshot、Corpus digest 与 unit history；删除展示层 Offer 字段不改事实历史。
5. 旧 Corpus 只做 read-time field stripping，不重写 content-addressed release。

迁移后，同一账号在 Web、Desktop、Runtime 看到的 active Entitlement ID 集合必须完全相同。

## 10. 安全与隐私

- Browser 使用 HttpOnly、Secure、SameSite cookie + CSRF；Desktop 使用 Registry opaque bearer，两者不互相复制。
- 所有 mutation 要求 durable Idempotency-Key。
- Public Product 仅包含公开 presentation；Buyer Workspace path/content、conversation、artifact body 不进入 Access ledger、Creator views、telemetry 或 logs。
- Runtime operational logs 只记录 allowlisted code/category，不输出 exception message、stack 或 private payload。
- Internal service token 不进入浏览器或 Desktop。

## 11. 验收门槛

上线前全部满足：

- unit：Dashboard、Access ledger、Runtime 全绿；
- browser E2E：public no-signin、signup returnTo、free confirm、lost-response retry、release_changed、Creator approve→preview→publish、rollback、responsive、keyboard、Axe；
- cross-process：真实 Dashboard child + Runtime HTTP/WS，覆盖 checkout 后发现、pinned release、reserve/release/consume、Dashboard outage + restart reconcile、revoke deny；
- Caddy/Compose config validation；
- 生产真实账号核对 Web、Desktop、Runtime 三边 Entitlement IDs；
- 生产公开 Creator/Product UUID URL、Creator↔Product link、free CTA、receipt、Desktop open；
- 代码和产品响应中不存在平台 Offer 字段或路由；仅允许 migration sanitizer 与明确的 negative compatibility test 出现旧字段名。

## 12. 明确不做

- 支付、价格、订阅、退款资金流、payout；
- slug identity 或旧 URL 兼容；
- Registry ownership projection；
- 为缺失 release/digest/UUID 猜值；
- 用 fixture 或 mock 代替生产 UAT。
