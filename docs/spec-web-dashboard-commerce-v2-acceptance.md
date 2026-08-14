# Free Access cutover acceptance

本文件对应 [Hatch Web、Desktop 与 Free Access 规范](./spec-web-dashboard-commerce-v2.md)。

状态含义：

- `Tested`：当前源码有自动化证据。
- `Production verified`：已用真实生产服务与账号复核。
- `Pending`：必须在本次部署后完成，不能用 fixture 代替。

| Gate | 状态 | 证据 |
| --- | --- | --- |
| Published Product 公开可浏览、无需登录 | Tested | Browser E2E + server metadata assertions |
| UUID Creator↔Product 双向链接 | Tested | Browser E2E |
| Product published 即显示 free Get access | Tested | Unit + Browser E2E |
| Signup/signin 保留 Product returnTo | Tested | Browser E2E |
| 免费确认原子创建 1 Order + 1 Entitlement | Tested | Access ledger tests + Dashboard integration |
| 重复提交/丢响应只产生一份 access | Tested | Browser E2E + ledger idempotency tests |
| Release 变化终止旧确认且零副作用 | Tested | Browser E2E |
| Web 与 Desktop 读取同一 Access ledger | Tested | Dashboard integration + Caddy contract test |
| Runtime 只用 Registry 验证 identity、从 Access 查询 entitlement | Tested | Runtime resolver test |
| Runtime reserve/release/consume、outage reconcile | Tested | 真实 Dashboard child + Runtime HTTP/WS cross-process test |
| Pinned release 不随 current release 漂移 | Tested | Cross-process test |
| Creator approve→preview→publish→share | Tested | Unit + Browser E2E |
| Rollback 保留 historical Order/Entitlement | Tested | Unit + Browser E2E |
| 旧 Portal Offer 字段持久化清除 | Tested | Portal migration unit test |
| 旧 immutable Corpus Offer metadata read-time 丢弃 | Tested | Agent Corpus unit test |
| Registry ownership routes disabled | Tested | Registry HTTP tests |
| Public internal Access API blocked | Tested | Caddy contract test |
| 320/390/768/1280、keyboard、Axe | Tested | Playwright matrix |
| 生产 Registry `agent_access` 已备份并清空 | Pending | 部署后数据库核对 |
| 生产 Web/Desktop/Runtime Entitlement UUID 集合一致 | Pending | 真实 Seth UAT account |
| 生产 Creator/Product UUID URL 与 free CTA | Pending | 真实 public HTTP/browser UAT |
| 生产 Desktop 可连接并列出同一 Entitlement | Pending | 正式 Hatch.app UAT |

## Production UAT account

使用专用真实账号 `seth-uat@example.com`。不得在验收中创建 fixture entitlement、伪造 Corpus digest 或把 Registry legacy access 当成成功。

期望结果：

1. Web `/library`、Desktop Product list、Runtime `/v1/me/creator-agents` 返回相同 active Entitlement UUID 集合。
2. 每条 binding 都有 UUID v4 buyer/creator/product/order/entitlement 和 exact purchased/effective Corpus digest。
3. Registry `/v1/user/product-access` 不存在；公网 `/v1/user/product-access` 由 Dashboard 返回 authoritative projection。
4. Published Product 不包含 Offer fields，也不会显示 unavailable merely because旧 Offer 缺失。
5. Desktop 无需重新打包；此次连接修复属于 Web/Caddy/Runtime service deployment。只有 Desktop source 发生必要变化时才发布新 installer。
