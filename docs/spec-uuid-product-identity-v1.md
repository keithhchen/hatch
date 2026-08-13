# UUID Product Identity v1

状态：已实现（free-only cutover）

目标：把 Creator 与 Product 的身份从可读 key 改为数据库生成的 UUID v4，并让 Web、Commerce、Runtime、Desktop 使用同一套 authority identity。

## 0. User flow（free-only cutover）

Buyer：匿名浏览 Explore 或分享的 Product URL → 查看完整 offer → 点击免费领取时再登录/注册 → 确认 → 得到唯一 Order receipt 与 Entitlement detail → `Open Hatch Desktop` → Desktop 用同一组 UUID 校验并开始工作。

Creator：进入 Studio → Factory 自动保存 → 查看 candidate/evidence → Approve → 设置一个免费 per-delivery offer → Storefront preview → Publish → 复制 Product URL → 查看 Orders/Delivery；Payout 显示真实的 unavailable/setup 状态，不伪造余额。

付费 checkout、subscription 和 provider payout 本轮不开放；任何非零 offer 在 production 必须 fail closed。

产品原则：每一步都告诉用户当前状态、下一步和恢复路径；公共浏览不要求登录；登录只发生在领取或访问私有资产之前。

## 1. Canonical URL

公开页面只有两类 canonical route：

```text
/creators/{creator_id}
/products/{product_id}
```

其中 `{creator_id}` 和 `{product_id}` 都是标准小写 UUID v4（36 字符，含连字符）。

Product 页面只使用 `product_id`。Product 与 Creator 的关系由数据库解析，不把 Creator UUID 重复放进 Product URL。

不支持：

- slug、handle、短 ID、Base58/Base64 编码；
- `/agents/*`、`/portal/*` 或旧 `/creators/{slug}/{product}`；
- alias、308 redirect 或旧参数兼容；
- 用名称、顺序编号或 hash 推导资源 ID。

## 2. Authority data model

所有 authority ID 由应用或数据库生成 `crypto.randomUUID()` / PostgreSQL UUID v4，创建后不可变。

```sql
CREATE TABLE creators (
  id UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE products (
  id UUID PRIMARY KEY,
  creator_id UUID NOT NULL REFERENCES creators(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
```

Commerce 相关表和事件使用 UUID：

- `product_id`、`creator_id`、`offer_id`；
- `order_id`、`entitlement_id`；
- 其他数据库生成的 aggregate identity。

`corpus_digest` 仍是内容寻址的 `sha256:<hex>`，不是 UUID。
`release_id` 是不可变 release authority；当前 free cutover 允许它引用该
release 的内容寻址 digest，但它不能替代 `product_id`，也不能由 URL 或名称推导。

数据库中不再保存 `seth`、`alpha-lite` 作为 authority ID。显示名称可以是 `Seth`、`Alpha Lite`，但不会参与资源查找或 URL 生成。

## 3. Corpus and Registry

Corpus manifest 使用 UUID：

```json
{
  "contract_version": "1",
  "creator": { "id": "<creator_uuid>", "name": "Seth" },
  "product": { "id": "<product_uuid>", "name": "Alpha Lite" }
}
```

不再使用顶层 `agent_id` 作为产品身份。`agent` 只可作为内部实现术语，不能出现在公开 identity contract 中。

Registry 的当前 Corpus、immutable release、access grant 和 Factory candidate 都以 `creator_id`/`product_id` UUID 关联。Filesystem 目录也使用 UUID：

```text
HATCH_AGENT_CORPUS_ROOT/{creator_id}/{product_id}/
```

Registry 必须拒绝：

- 非 UUID v4 的 Creator/Product ID；
- product 不属于 URL 中请求的 creator（若请求含 creator scope）；
- 通过名称或旧 key 猜测资源。

## 4. Public API and BFF

```text
GET /v1/public/creators
GET /v1/public/creators/{creator_id}
GET /v1/public/products
GET /v1/public/products/{product_id}
```

Public product response 至少包含：

```json
{
  "product_id": "<uuid>",
  "creator_id": "<uuid>",
  "name": "Alpha Lite",
  "creator": { "id": "<uuid>", "name": "Seth" },
  "public_url": "/products/<uuid>",
  "offer": {}
}
```

订单、Entitlement、Checkout session、Factory、Offer 和 Release response 只传 UUID authority 字段，不传 slug 作为查询条件。

## 5. Desktop contract

Web 的 `Open Hatch Desktop` 使用新的 deep link：

```text
hatch://products/open?entitlement_id={entitlement_uuid}&product_id={product_uuid}
```

Desktop 必须：

1. 解析 `product_id` 和 `entitlement_id`；
2. 从 Registry 重新读取当前账户的 Entitlement；
3. 校验两者匹配，并取得 `creator_id`、purchased/effective corpus digest；
4. 用 UUID 建立 Runtime scope；
5. 不接受名称、slug、旧 `agent_id` 或 URL 中携带的任意 corpus path。

Desktop bundle 注册 hatch URI scheme；App 未启动时读取 launch URL，App 已启动时由
single-instance relay 转发到现有窗口。Rust/native boundary 和 renderer 都先做
UUID v4 与 hatch://products/open 校验，随后仍必须重新读取 Registry Entitlement；
deep link 只是 navigation hint，不是授权凭据。

Runtime handshake、conversation scope 和 Commerce delivery binding 统一使用：

```text
entitlement_id
creator_id
product_id
```

Runtime 根据 `product_id` 解析当前/购买版本的 immutable Corpus，不让 Desktop 直接选择 Corpus 文件路径。

## 6. Factory and publish

创建 Product 时先生成 `product_id` UUID，再创建 Factory run。所有 candidate、approval、offer、preview、publish、rollback 都绑定同一 Product UUID。

发布新 release 只改变 `release_id` 和 `corpus_digest`，不能改变 `product_id`。

Creator account 使用 `creator_id` UUID；Factory run 的 creator scope 取自认证账户，不能由 body 覆盖。

## 7. Caddy and deployment

Caddy 只把以下页面交给 Dashboard：

```text
/creators/*
/products/*
/explore
/library/*
/orders/*
/checkout/*
```

`/agents/*`、旧 `/portal/*` 和旧 slug 形式不做 redirect，直接返回 404。Runtime、Registry internal routes 继续保持内部，不因新 public route 暴露。

## 8. Cutover policy

这是一次 identity cutover，不做向前兼容：

1. 停止旧 Web/Runtime/Registry；
2. 执行数据库迁移，创建 UUID Creator/Product rows；
3. 重写现有 Corpus manifest、Factory seed、Commerce fixtures 和 Desktop fixtures；
4. 清理旧 text identity columns、旧 JSON state 和旧 filesystem paths；
5. 重新发布 UUID Corpus；
6. 再部署 Dashboard、Runtime、Desktop。

任何未迁移的旧记录必须使启动或迁移失败，不能静默生成临时映射。

## 9. Acceptance tests

- 匿名打开 `/products/{uuid}` 得到完整 public product；
- `/creators/{uuid}` 只列出该 Creator 的 Products；
- 不带 slug 的 URL 在刷新、分享、禁用 JavaScript 时仍成立；
- 任意两个 Creator/Product UUID 不重复，且重启后不变化；
- 同一 Product 的新 release 不改变 Product UUID；
- Creator UUID 与 Product UUID 不匹配时返回 404；
- 旧 `/agents/*`、旧 slug、旧 `agent_id` 请求返回 404/400；
- Web checkout → entitlement → Desktop deep link → Runtime turn 全程使用同一 UUID；
- revoke 后已有 Desktop session 下一次 Runtime 请求被拒绝；
- Caddy production smoke 覆盖 `/creators/*`、`/products/*`、`/v1/public/*` 和 deep link 参数。

Desktop cold-start 与 already-running 两种 hatch://products/open 打开方式都能选中同一个
Entitlement；无匹配 entitlement 时保持未连接，不创建 access。

## 10. Non-goals

- 不做可读 slug、SEO alias 或旧链接迁移；
- 不做短 ID 编码协议；
- 不让 Desktop 直接打开任意 URL 或本地 Corpus；
- 不把 UUID 暴露之外的内部 Factory/Filesystem 状态带到 public response。
