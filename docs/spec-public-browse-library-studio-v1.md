# Public Browse、Library 与 Studio

状态：Current UI companion spec
Authority：[Hatch Web、Desktop 与 Free Access 规范](./spec-web-dashboard-commerce-v2.md)

## Information architecture

```text
Explore (public)
├── /creators/{creator_uuid}
└── /products/{product_uuid}

Account (private)
├── /library
├── /library/{entitlement_uuid}
├── /orders
├── /orders/{order_uuid}
└── /account

Studio (Creator)
├── /studio
├── /studio/products/{product_uuid}
├── /studio/products/{product_uuid}/factory
├── /studio/products/{product_uuid}/candidates/{candidate_id}
├── /studio/products/{product_uuid}/preview
├── /studio/products/{product_uuid}/versions
└── /studio/orders
```

Slug route、`/portal`、`/agents` 与角色混合主页不是兼容入口。

## Public Browse

- `/` 与 `/explore` 都是公开浏览入口。
- Creator/Product 页面无需登录，可刷新、可分享、server HTML 有 canonical/OG metadata。
- Creator 页面列出其 published Products。
- Product 页面 Creator name 是 `/creators/{creator_uuid}` link。
- Published Product 的主 CTA 固定为 `Get access`，显示 `Free`；没有价格或额外销售状态。
- 匿名点击 CTA 进入 auth，并只保留 `/products/{product_uuid}` returnTo。

## Free confirmation

确认页显示：

- Product 与 Creator；
- exact current release；
- 1 delivery unit；
- Payment: Not required；
- `Add this Product to my account` confirmation；
- `Add to my account` 主 CTA。

Client 只提交 `product_id`。Release 变化时旧确认终止、零副作用，用户回到 Product 创建新 intent。

成功页是 durable URL，不是 toast；包含 Receipt、View in Library、Open Hatch Desktop 与 Download。

## Library

- Library 是 authoritative Entitlements，不是 catalog 副本。
- Card 和 detail 都可导航；拥有状态不能做成不可点击按钮。
- `remaining_units = 0` 显示 Used；revoked/expired 禁止新 run，但 Receipt 可读。
- `Open Hatch Desktop` 使用 Entitlement/Product UUID deep link。
- Desktop 使用同一账号时必须看到同一 Entitlement UUID。

## Orders

- 免费领取仍产生 Order，`payment_status = not_required`。
- Order detail 分开显示 Order、Entitlement、Delivery 状态。
- Order 保存 Product、Creator、release 与 access policy snapshot。
- 列表真实分页，不截成最近五条。

## Studio

- Factory draft server autosave，刷新恢复；stale tab 不能覆盖新版本。
- Candidate review 展示 evidence、gates、known losses、Corpus/report digest。
- Approve 后直接进入 shared storefront preview；Preview 与 public Product 共用 component/model。
- Publish 后复制 `/products/{product_uuid}`。
- Rollback 选择 exact immutable release，并要求 audit reason。
- Creator Orders 只展示 access/delivery operational facts；不展示 Buyer Workspace、conversation、file path 或 artifact content。

## Global UX

- Loading 显示 skeleton/progress，不提前显示 empty。
- 401 回到 exact returnTo；403/404/withdrawn/offline/revoked 状态不混淆。
- route change 后 focus 页面 h1；键盘路径覆盖 auth、confirm、approve、publish、rollback。
- 320、390、768、1280 无横向溢出，CTA 最小 44×44，不被 sticky/fixed 元素遮挡。

## Acceptance

详见 [Free Access cutover acceptance](./spec-web-dashboard-commerce-v2-acceptance.md)。Fixture 只用于自动化，不可当生产 UAT。
