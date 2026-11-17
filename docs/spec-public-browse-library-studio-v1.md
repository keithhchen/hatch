# Public Browse、Library 与 Studio

状态：Current UI companion spec
Authority：[Hatch Web、Desktop 与 Open Access 规范](./spec-web-dashboard-commerce-v2.md)

## Information architecture

```text
Explore (public)
├── /creators/{creator_uuid}
├── /products/{product_uuid}
└── /chat/product/{product_uuid}

Account (private)
├── /library
└── /account

Studio (Creator)
├── /studio
├── /studio/products/{product_uuid}
├── /studio/products/{product_uuid}/factory
├── /studio/products/{product_uuid}/candidates/{candidate_id}
├── /studio/products/{product_uuid}/preview
├── /studio/products/{product_uuid}/versions
└── /studio/users
```

Slug route、`/portal`、`/agents` 与角色混合主页不是兼容入口。

## Public Browse

- `/` 与 `/explore` 都是公开浏览入口。
- Creator/Product 页面无需登录，可刷新、可分享、server HTML 有 canonical/OG metadata。
- Creator 页面列出其 published Products。
- Product 页面 Creator name 是 `/creators/{creator_uuid}` link。
- Published Product 的主 CTA 是 Chat：直接打开 `/chat/product/{product_uuid}`，访客也可以对话；没有价格、结账或确认页。

## Library

- Library 是账号保存的 Agents（active 免费 entitlement），在账号第一次对某个 Agent 发起 Run 时自动保存；它不是 catalog 副本，也不门控对话。
- Card 可导航到该 Agent 的对话；每张卡有 Remove（移除不删除对话）。
- Desktop 使用同一账号时必须看到同一组 Product。

## Studio

- Factory draft server autosave，刷新恢复；stale tab 不能覆盖新版本。
- Candidate review 展示 evidence、gates、known losses、Corpus/report digest。
- Approve 后直接进入 shared storefront preview；Preview 与 public Product 共用 component/model。
- Publish 后复制 `/products/{product_uuid}`。
- Rollback 选择 exact immutable release，并要求 audit reason。
- Studio Users 页只展示访客/账号/IM 联系人的对话与消息计数和时间；不展示用户 Workspace、conversation 内容、file path 或 artifact content。

## Global UX

- Loading 显示 skeleton/progress，不提前显示 empty。
- 401 回到 exact returnTo；403/404/withdrawn/offline/revoked 状态不混淆。
- route change 后 focus 页面 h1；键盘路径覆盖 auth、chat、approve、publish、rollback。
- 320、390、768、1280 无横向溢出，CTA 最小 44×44，不被 sticky/fixed 元素遮挡。

## Acceptance

验收门槛见 Open Access 规范第 11 节。Fixture 只用于自动化，不可当生产 UAT。
