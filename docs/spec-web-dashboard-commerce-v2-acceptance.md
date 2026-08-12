# Web Dashboard Commerce V2 — acceptance status

更新日期：2026-08-12。对应规范：[`spec-web-dashboard-commerce-v2.md`](./spec-web-dashboard-commerce-v2.md)。

本文只记录当前 working tree 可复跑的证据：

- **Tested**：关键成功、失败和重放状态已有自动化，且没有已知相反实现。
- **Partial**：仓库实现与本地自动化已覆盖主体，但仍缺外部 provider、人工 screen-reader、remote CI 或 production smoke。
- **Blocked**：需要尚未确定的外部合同、凭据或业务政策；生产路径保持 fail closed。

## R01–R32

| ID | 状态 | 当前自动化证据 | 仍缺 |
| --- | --- | --- | --- |
| R01 | Tested | Browser 在 320/390/768/1280 验证 anonymous canonical product、完整 storefront、无溢出和 visual baseline；原始 HTTP HTML 验证 product-specific title/description/canonical/OG；未发布或withdrawn route在JS前返回404、requested canonical与`Agent unavailable` metadata；unit覆盖escaping与危险 URL。 | — |
| R02 | Tested | Browser 从 product CTA 分别完成 sign-in/sign-up，恢复原 product intent；外域 `returnTo` 被拒绝。 | — |
| R03 | Tested | Browser 覆盖 double submit，以及服务端已提交但响应丢失后用同一 key 重试；严格断言一个 order、一个 entitlement、零 revenue、一个 access grant。 | — |
| R04 | Tested | Browser 制造 active offer 变化，显示 old/new quote、锁定旧 CTA、证明零 Commerce 副作用，再用 fresh quote 确认。 | — |
| R05 | Tested | `runtimeCommerceCrossProcess.test.ts` 先启动真实 Runtime，再由真实 Dashboard child process checkout，无需重启即可 authorize/reserve。 | — |
| R06 | Tested | 同一跨进程测试完成 free delivery、consume unit、记录 purchased/effective digest，并断言无 revenue。 | — |
| R07 | Tested | Artifact 后强停 Dashboard，Runtime 返回 completed + receipt syncing；重启 Dashboard/Runtime 后 durable outbox exactly-once 补账。 | — |
| R08 | Tested | 跨进程 failed/cancelled run release reservation，后续 delivery 证明 unit 可复用且无 revenue。 | — |
| R09 | Tested | Registry direct grant 要求 access service principal；Buyer token 被拒；Caddy 对 public internal Commerce/Deployment routes 返回 404。 | — |
| R10 | Tested | Browser 对 success/order/entitlement/library durable URLs 分别 refresh；R03 同时证明 refresh/retry 不重放 checkout。 | — |
| R11 | Tested | Library detail 的 Back 返回 Library，且不出现错误的 Explore back-link。 | — |
| R12 | Tested | Browser 清除/失效 session 后打开 protected receipt，验证安全 same-origin `returnTo`，重新登录后恢复原 URL；Orders 401 不再形成 redirect loop。 | — |
| R13 | Tested | Browser 验证 Factory autosave refresh 恢复；PUT/flush 失败会阻止 in-app navigation，并保留本地内容。Unit/API另证明同save key精确replay、changed payload冲突，以及已提交但响应丢失后的相同snapshot恢复。 | — |
| R14 | Tested | 两个独立 browser context 同版编辑；stale tab 得 409，refresh 证明没有覆盖 winner。Portal/Postgres mutation测试覆盖并发 CAS。 | — |
| R15 | Tested | Browser 在同一 run route 替换 question batch：旧答案被 quarantine、可显式复制，但不会进入新 batch submission；提交审计只含新 question ID。 | — |
| R16 | Tested | Browser/keyboard 显示 failed critical gate 并禁用 approval；伪造 approve 请求由 server 拒绝。 | — |
| R17 | Tested | Dashboard saga test分别改变 report digest 与 Corpus digest，使 approval/pending publish stale；必须重新 review 才能发布。 | — |
| R18 | Tested | Portal saga fault tests覆盖 publish/rollback intent 跨重启 resume；Dashboard fault integration证明 Registry activation failure 时旧 storefront tuple 持续可用，重试不重复 release/offer。 | — |
| R19 | Tested | Keyboard Creator browser journey从server-autosaved task/sources开始，显式Start distillation，沿durable Factory run进入candidate → approve → offer → shared preview → publish → share/copy；public storefront与 preview共用 model/component。 | — |
| R20 | Tested | Browser 发布两份 immutable release，rollback 缺 reason 被拒、Registry 首次 activation 失败不切 pointer、重试成功；历史 order/entitlement snapshot不改写。Unit 另断言完整 audit envelope。 | — |
| R21 | Tested | Browser/真实 ledger fixture 用 cursor 加载 13 条 Creator orders，并覆盖 server-side filter。 | — |
| R22 | Tested | 跨进程 refund/revoke 后已连接 Runtime 在 reserve 处 deny，新连接在 Registry 处 deny；BFF outbox 保持最终收敛。 | — |
| R23 | Partial | Sandbox 与 production-mode HTTP bridge 均完成 delivery 后 refund；真实 HTTP 边界验证 Bearer、stable Idempotency-Key、Payment/provider identity，Commerce原子写 payment refund、revenue reversal、payout adjustment、entitlement revoke。 | 外部 provider sandbox/production contract与真实凭据。 |
| R24 | Partial | Sandbox requires-action/failure 不创建 order/entitlement/grant；真实 HTTP provider bridge 故意让 create-intent 返回 `succeeded`，BFF 仍保持 pending，只有 signed webhook 后才 exactly-once fulfillment。Buyer 有 polling/recovery UI；若授权交付同时超过配置的 SLA 与重试上限，reconciler 会 exactly-once 发起 provider-confirmed 补偿退款、撤销 entitlement，并把 checkout 收敛为 `refunded`。 | 外部 payment provider sandbox 与运营政策。 |
| R25 | Partial | Production-mode HTTP bridge覆盖 Bearer、stable Idempotency-Key与 signed webhook authority；provider success通过一个 Commerce command把 durable inbox、`payment.succeeded`、order、entitlement、outbox与read models同 transaction提交，冲突全回滚；webhook测试覆盖 duplicate、tamper、expired timestamp、late/out-of-order；Registry projection拒绝状态倒退。 | 外部 provider webhook重放与 production cross-service smoke。 |
| R26 | Tested | Commerce test用同一 Buyer 两个独立 paid orders/units完成两次 delivery/revenue，各自绑定且总额不越界。 | — |
| R27 | Tested | 跨进程购买 pinned V1 后发布 V2，Runtime session/delivery仍使用 V1，receipt同时记录 purchased/effective digest。 | — |
| R28 | Tested | Runtime完整 lineage walk + 跨进程 V1→compatible V2 / breaking V3；BFF再用 deployment-token向 Registry读取并重新 verify exact immutable release，重算 declaration、核对 identity/direct predecessor后才写唯一 `version_advanced`。 | — |
| R29 | Tested | 320/390 browser断言无横向溢出、44px CTA hit target、中心 hit-test、无 sticky/fixed overlap、account/sign-out可达并可真实点击。 | Remote Linux pixel baseline仍由 CI 首次运行确认。 |
| R30 | Partial | Buyer free checkout与 Creator approve/publish/rollback/copy均用真实 Tab/Enter/Space/keyboard typing；异步 h1 focus、status语义、focused skip link和 Axe A/AA gate通过。 | 仍需在目标 OS 做一次人工 VoiceOver/NVDA smoke。 |
| R31 | Tested | Creator Orders/export使用字段 allowlist；Commerce private-field matrix、telemetry schema/rate-limit、Runtime outbox与 structured operational log tests均证明不读取/输出 prompt、files、Workspace path、artifact content、token或 raw exception。Dashboard 路由级测试另证明未知 5xx 与 provider-supplied failure text会被稳定类别替代，不会进入 Buyer/Creator response或财务 read model。 | — |
| R32 | Partial | Sandbox覆盖provider failure/release/retry/旧attempt乱序；production-mode HTTP bridge另跑通 payout onboarding、active account、balance reserve、transfer submission与provider status reconciliation。查询只按当前 immutable provider attempt，terminal state幂等落账；查询失败保留retry count/last safe category且不会误释放未知状态资金。自动payout默认`disabled`且有negative test证明recognized balance不会触发transfer；当前仅在显式`immediate` schedule + positive minimum政策下提交。 | 外部 payout provider sandbox、真实KYC/onboarding、凭据与最终schedule/minimum/reserve政策。 |

## Cross-cutting launch gates

| Gate | 状态 | 证据与结论 |
| --- | --- | --- |
| Production Commerce source of truth | Tested locally | Production强制 Postgres；events/outbox/inbox、typed `commerce_read_models` + watermark及 Portal workflow state均在数据库。append transaction原子更新 audit events、outbox与read model，open可 deterministic backfill/repair；Runtime仅走 authenticated HTTP，不持有 Commerce DB credential。Registry legacy offer会在首次公开报价前以deterministic key导入一份Commerce revision + activation；一旦Commerce已有active offer，Registry drift不能静默替换报价。 |
| Atomicity / idempotency / real DB | Tested locally | Commerce unit 44/44；paid webhook transaction测试覆盖 inbox + payment + order + entitlement + outbox + read models一次提交、replay及冲突全回滚。Order event/read model固定保存subtotal、discount、tax（可为`not calculated`）与total，并拒绝无法对账的quote；Buyer durable receipt恢复同一拆分。CI定义真实 PostgreSQL service，另覆盖 concurrent writers、read-model failure、`SKIP LOCKED` outbox与四个 least-privilege DB roles。当前机器无运行中的 PostgreSQL daemon，本轮未重复启动该 job。 |
| Runtime delivery outage semantics | Tested | 真实 Dashboard child process + Runtime HTTP/WS + file outbox覆盖启动顺序、成功、失败、取消、强停、双进程重启、补账、退款 deny 与 release pinning。 |
| Publish/rollback deployment saga | Tested | Registry提供 stage-only + CAS activate；Portal持久化 phase checkpoints；Commerce activation以 deployment operation为幂等 identity。Factory-only首发不伪造 legacy pointer，真实 legacy storefront在 replacement commit前保持稳定。 |
| Browser session / CSRF / capability / audit | Partial | HttpOnly opaque Web session、same-origin CSRF、request ID及高风险 mutation audit reason/envelope已有自动化；完整 Creator negative capability matrix覆盖 Factory、Product、approval、publish、rollback、Orders/export、refund与Payout，并证明拒绝发生在 Registry/Commerce副作用前。仍需在 production smoke验证反向代理下的 Secure cookie attributes。 |
| Public metadata | Tested | BFF在 pre-JS product response注入安全 metadata；browser直接断言原始 navigation response，unit覆盖 escaping与恶意 URL。 |
| CI / CD | Implemented, pending remote proof | CI包含 Dashboard、Commerce、Runtime、真实 Postgres、Playwright/Axe/visual与container build；CD只接受 same-repo master push的成功 CI `head_sha`，最小权限、production concurrency与readiness均已接线。健康检查后，host-only UAT凭据运行canonical metadata、cookie/CSRF及production cookie attributes、product-release+offer-keyed free checkout、immutable Order/Entitlement snapshot、receipt与download smoke；应用重部署只重放同一收据。失败时恢复known-good release并重新验证三项readiness；首发无previous时停止未验证stack并删除失败marker。仍需一次远端 workflow执行证明。 |
| Repository test health | Local green | Dashboard 62/62 + production build；Commerce 44/44；Runtime 228/228；Playwright 60 total = 19 passed / 41 intentional project skips / 0 failed；Compose app/infra config、workflow YAML、Node syntax与 `git diff --check` 均通过。 |
| Analytics / operations | Partial | Funnel telemetry有 allowlist、幂等、隐私拒绝与rate limit；authenticated internal operations同时输出只含计数的 funnel summary，以及 fulfillment/captured-without-order、reservation、revenue、refund projection、outbox与payout alerts；checkout reconciler覆盖重试后自动 provider-confirmed 补偿退款；[`commerce-operations-runbook.md`](./commerce-operations-runbook.md) 给出内部查询、safe replay、隐私和exit criteria。仍缺外部 alert sink/dashboard与production演练。 |
| Legacy UAT isolation | Tested | `pay_zero_*` / 零金额历史投影为 `payment_status=not_required` 且清除 payment ID；Runtime Registry回归证明缺 order或immutable purchased digest的旧 lifetime access不投影，必须经明确units/validity/version policy迁移后重发。 |
| Paid/payment/payout rollout | Blocked for production | Payment/refund/payout aggregates、provider-neutral HTTP adapter、signed webhook、transactional inbox、sandbox与reconciliation已实现。生产默认 `disabled`；即使配置provider凭据，也必须显式设置 `HATCH_COMMERCE_PAID_LAUNCH_APPROVED=true`，并在CD声明`HATCH_PAYOUT_SCHEDULE=immediate`及positive minimum，才能启动provider模式。未决merchant、地区、tax、refund、KYC/payout/currency/reserve政策不会退化成隐式默认。 |
| Manual accessibility / production smoke | Partial | 自动 keyboard、focus、ARIA、Axe与responsive matrix均绿；production smoke runner及CD gate已有fixture测试。2026-08-12对当前线上做public-only只读执行，明确失败于缺少canonical metadata，证明线上尚未部署本working tree；未在本地对线上执行会写订单的authenticated smoke。仍需目标系统的 VoiceOver/NVDA、remote Linux visual baseline，以及获授权发布后由CD跑通完整production smoke。 |

## Verification commands

```bash
npm --prefix creator-dashboard test
npm --prefix creator-dashboard run build
npm --prefix creator-dashboard run test:e2e
HATCH_TEST_COMMERCE_DATABASE_URL=postgresql://... \
HATCH_TEST_RUNTIME_DATABASE_URL=postgresql://... \
  npm --prefix creator-dashboard run test:postgres
npm --prefix packages/commerce test
npm --prefix runtime-server test
```

结论：Buyer 与 Creator 的 free loop、provider-neutral Phase 2代码、数据一致性、安全边界、旧数据隔离和本地验收已实现；production provider create response也不能绕过signed webhook。规范 Definition of Done 仍不能宣称 production complete：外部 payment/payout provider与业务政策尚未落定，当前生产尚未部署本working tree，且仍需 remote CI/CD、人工 screen-reader及部署后的authenticated production smoke。
