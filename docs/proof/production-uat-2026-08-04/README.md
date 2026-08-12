# Production UAT — 2026-08-04

## 结论

端到端主链路已在生产环境完成验收：

```text
官网浏览 Creator Agent
→ Agent 详情
→ 0 元购买 / 订单
→ 用户 entitlement
→ Desktop 登录
→ 加载已购买 Agent
→ 选择 Workspace
→ 选择权限 / 开启 Shell access
→ Agent 读取 Workspace 文件
→ 请求写入批准
→ 生成并保存可交付文件
```

本次验收基于 master 的 `2ec9b7a`，实际使用生产域名和当前 workspace 构建的 Tauri Desktop。最终结果不是只看到“请求成功”，而是确认交付文件真实落在 Workspace 中。

## 验收环境

- 生产入口：[https://hatch.tokenquadrant.cn/portal/](https://hatch.tokenquadrant.cn/portal/)
- Runtime WebSocket：`wss://hatch.tokenquadrant.cn/v1/runtime`
- 发布提交：`2ec9b7a fix: disable kimi thinking for bounded delivery`
- Compose 服务：`caddy`、`registry`、`runtime`、`dashboard`、`postgres`、`qdrant`
- 当前生产健康检查：`/healthz`、`/api/health` 均返回 200
- GitHub Actions CI：`30906368448`，成功
- GitHub Actions CD：`30906367877`，成功

## 用户链路证据

### Web：浏览、购买、授权

生产 Catalog 返回 canonical Agent：

- Creator：`maya-chen`
- Agent / Product：`signal-resume-review`
- 购买后订单状态：成功
- 购买后 entitlement：`active`
- Desktop 使用的权限查询：`GET /v1/user/agent-access`

截图：

- [01 — Portal 登录](./screenshots/01-portal-login.png)
- [02 — Catalog 购买前](./screenshots/02-catalog-before-purchase.png)
- [03 — 购买成功与订单](./screenshots/03-purchase-success-order.png)
- [04 — My Agents](./screenshots/04-my-agents-view.png)

### Desktop：登录、选择 Agent、Workspace、权限、聊天、交付

使用新建的合成 UAT 用户完成登录。密码和 token 没有写入仓库、报告或飞书消息。

验证结果：

- Desktop 使用生产 Auth endpoint 登录成功。
- 登录后只加载该账号有权使用的 Agent：`Signal Resume Review · Maya Chen`。
- 选择了 `fixtures/consumer/jordan-signal-resume/workspace` 作为 Workspace。
- 顶部 Workspace folder selector 可用。
- Permissions selector 为 `Ask before changes`。
- Shell access 为 `On`，并显示 `Commands always ask for approval`。
- 聊天期间显示 `Stop streaming`，说明 streaming 可被用户中止。
- Agent 成功读取 `resume.md` 和 `target-role.md`。
- Agent 对写入 `production-delivery-desktop-2ec9b7a.md` 请求批准。
- 用户点击 `Allow` 后，UI 显示 `Completed and saved`。

最终交付物：

- 路径：`fixtures/consumer/jordan-signal-resume/workspace/production-delivery-desktop-2ec9b7a.md`
- 大小：9,386 bytes
- SHA-256：`61fca3b78205a63e3430972b722a35554d87b8bf486245d9bdfb38e3d8b0b900`

截图：

- [08 — 当前 Desktop 登录后](./screenshots/08-desktop-current-build-signed-in.png)
- [09 — Workspace 已就绪](./screenshots/09-desktop-workspace-ready.png)
- [10 — Streaming 中的 Stop](./screenshots/10-desktop-streaming-stop.png)
- [11 — 用户中止后的任务](./screenshots/11-desktop-stopped-task.png)
- [18 — 生产交付成功](./screenshots/18-desktop-production-delivery-success.jpeg)

## 生产 Runtime 直接验收

为避免只依赖 GUI，本次也用同一生产链路执行了可复现 runner：

> 这份证据记录的是当时的 protocol 0.5，因此保留旧名 `fs.read` / `fs.write`。
> 当前 protocol 0.6 中对应名称是 `file_read` / `file_write`；旧名不再是可调用接口。

- Commerce：创建合成用户、购买 Agent、确认 order 和 entitlement。
- Runtime：通过生产 WebSocket 执行 `fs.read` × 2 和 `fs.write` × 1。
- 事件数：26
- 最终状态：`completed`
- 交付文件：9,401 bytes
- SHA-256：`fce4d55d3dc5991a7c727a484f0ff450197008789c5307f9ca78dd611f0afdb1`

这次历史 UAT 所用的 `scripts/production-uat-delivery.mjs` 没有保留在当前
worktree，且它锁定的是已废弃的 protocol 0.5，不应再被当作可复现入口。当前的
Desktop 候选包与可审计 SHA-256 入口见
[Desktop automated CI UAT](../desktop-ui/automated-ci-uat.md)；生产 Runtime 的
验证必须使用当前 protocol、受控的合成账户和单独批准的生产 UAT 运行册。

## 发现的问题与处理

### 1. Desktop 旧 binary 造成错误判断

测试初期命中了其他 worktree 的旧 `Hatch.app`，界面是旧版，登录失败提示也会误导排查方向。当前 source 的 endpoint 实际已经对齐新 Registry：

- `POST /v1/auth/signin`
- `GET /v1/user/agent-access`
- `GET /v1/catalog/agents`
- `wss://hatch.tokenquadrant.cn/v1/runtime`

处理方式：重新构建当前 master workspace 的 Tauri app，并用该绝对路径验收；新 build 登录、加载 entitlement 和聊天均通过。后续发布 Desktop 时必须保证安装包来自当前 master 构建产物。

### 2. Agent Corpus 读取完成后无法稳定交付

初始真实链路会在读取文件后停留在准备阶段，不能稳定产生最终文件。原因是工具证据 handoff 把不必要的工具历史带入了后续模型请求，导致上下文膨胀并破坏边界交付。

处理方式：Runtime 将当前任务和已批准证据压缩为 bounded handoff；当时的文件写入由 Runtime-owned `fs.write`（现为 `file_write`）完成；没有写文件请求时不再错误地携带工具协议。

### 3. Kimi 默认 thinking 消耗了 bounded delivery 的 completion budget

证据较长时，省略 `thinking` 会触发模型默认思考；`temperature=1` 还会与关闭 thinking 的请求约束冲突，导致超时或 400。

处理方式：统一使用 `temperature=0.6` 和显式 `thinking: { type: "disabled" }`，覆盖 Runtime、Factory、compaction 和 blind comparison 路径；补齐 provider 与 E2E 测试。

修复后 Runtime 测试结果：145 tests，135 pass，10 skipped，0 fail。

## 残余事项

- GitHub Actions 仍会提示部分第三方 action 的 Node.js 20 deprecation warning；本次 CI/CD 不受影响，后续可随 action 新版本升级处理。
- 前端构建仍有 module-level `"use client"` 和大 chunk warning；不影响本次功能验收，但应作为性能与构建卫生任务跟进。
- 本次使用的是合成 UAT 用户和合成 Workspace 文件；生产产生的测试订单、entitlement 和文件需按运营策略定期清理。
