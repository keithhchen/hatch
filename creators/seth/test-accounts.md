# Seth 测试账号

## 本地 UAT 用户

| 用户名 | 密码 | 角色 | Entitlement / Agent access |
|---|---|---|---|
| `jordan@example.com` | `hatch-local-uat` | user | `seth / alpha-lite` — Seth Database Alpha Lite |

Agent 标识：

- Creator：`seth`
- Agent：`alpha-lite`
- Product：`alpha-lite`
- 名称：Seth Database Alpha Lite
- Access 状态：通过 zero-value checkout 后为 `active`

该账号与密码来自 [`creator-dashboard/fixtures/local-uat.json`](../../creator-dashboard/fixtures/local-uat.json)，仅用于本地测试。生产账号不要复用这组凭据。

## 生产 UAT 用户

| 用户名 | 密码 | 角色 | Entitlement / Agent access |
|---|---|---|---|
| `seth-uat@example.com` | `hatch-seth-uat` | user | `ent_e5d2091763244b0490b7ecf0903c443e` → `seth / alpha-lite` |

该账号已完成生产 zero-value checkout，当前 access 状态为 `active`，并已通过 Runtime 查询 NVIDIA（NVDA）。
