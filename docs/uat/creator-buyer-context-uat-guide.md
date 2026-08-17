# Hatch Product Workflow UAT Guide

本文件是 Creator Product、Context Intake 和 Buyer Desktop 的真实产品 UAT 记录。自动化测试、生产浏览器行为、provider 阻塞分开记录；截图只来自真实生产页面。

## 1. 工作流与锁定规则

```
Files ──(Factory evidence generation)──> About You
About You ──(Factory evaluation / Corpus generation)──> Review
Review ──(Creator decisions / held-out gate)──> Brief
Brief ──(Creator-authored buyer questions)──> Complete
Complete ──(release command)──> Published Product
```

所有五个步骤始终可见。服务端的 `workflow_step`、`status`、`stage` 和 immutable Product revision 是 source of truth：

- 当前步骤在 provider turn、queued/running 或 retry 时显示 loading indicator。
- 当前步骤之后的 tabs 保持可见但 disabled；不能通过路由直接跳过 gate。
- 浏览器刷新后按服务端投影恢复当前步骤、loading 和 disabled 状态。
- `needs_attention` 停留在失败的当前步骤，显示真实错误和 Retry；不会把后续步骤误标为可用。
- Review correction 或 sealed held-out correction 创建新的 immutable Version；旧 Version 不被覆盖。

已保存的真实截图：

![Version 4 Review loading with future steps disabled](screenshots/creator-version4-review-loading.jpg)

## 2. Data Structure / Source of Truth

### Product

`CreatorProductRecord` 是 Product identity 的唯一 authority：

```text
id                 stable Product UUID
creatorId          owning Creator
name
promise            buyer-facing delivery promise
briefSpec          creator-authored BriefSpec (published gate)
status             draft | active | published | withdrawn
resourceVersion    CAS/version for mutations
latestRevisionId   Product graph pointer, advanced only after immutable revision exists
```

### Product File / Snapshot

Product Files 是 Context Intake 和 Creator Studio 的共同输入边界；写入不会直接创建 Version/Run。

```text
ProductFile:
  id, artifactId, productId, displayName, mediaType, bytes, sha256
  projection: { kind, mediaType, sha256, bytes, content/base64 }
  metadata: { sourceKind, sourceRef, sourceUrl, provenance,
              selectionReason, creatorApproved, timeRanges }

ProductSnapshot:
  id, productId, fileIds, digest, createdAt
  immutable ordered source set used by one Factory revision
```

### Factory Run / Version

`FactoryRunRecord` + its immutable graph/artifacts determine the Creator workflow:

```text
id, productId, revisionNumber, parentRevisionId, sourceSnapshotId
status: queued | running | waiting_for_creator | ready | needs_attention
stage: extracting_evidence | awaiting_creator_answers |
       compiling_corpus | evaluating_development |
       evaluating_regression | evaluating_heldout |
       review_required | ready | needs_attention
workflowStep: files | about-you | review
version, pendingQuestions, answerDrafts, pendingAnswers
candidate: { version, digest/reportDigest, verified Corpus references }
retryStage, lastError, retryable
```

The UI must not derive progress from a local spinner or from an old run after a new Files command. A Files submission optimistically points at `files` only until the new server run is returned; the returned run then becomes authoritative.

### Review projection

`GET /v1/creator/factory-runs/:id/review` is a read-only projection over the candidate:

```text
candidate_digest, candidate_version
cases[]: { id, question, creator_reference, candidate_output,
           verdict, diagnosis, case_digest, status }
blind: { sealed, total, passed, failed, needs_creator_action }
unresolved_count, correction_count, rerun_ready, release_ready
```

Held-out case text, answers and candidate output remain sealed. A failed sealed gate can only be advanced by explicit Creator correction (`heldout_correction`), which creates the next Version.

### Brief / buyer Task

`BriefSpec` is Product-owned and creator-authored. A buyer Task stores an immutable `BriefSnapshot` in the Conversation JSONB (spec digest + ordered answers). Runtime instructions remain authoritative; buyer answers are untrusted task material and cannot override Creator instructions.

### Context Intake OAuth grant

The plugin stores only the durable OAuth grant locally (macOS Keychain in this UAT). Browser authorization uses Authorization Code + PKCE (`state`, CSRF, S256). Product-only scopes are:

```text
creator:products:read
creator:products:write
creator:files:read
creator:files:write
```

## 3. Creator UAT checklist

1. Sign in as a real Creator.
2. Create/select a Product and upload real Product Files.
3. Click **Continue with these files**. Verify Files shows loading, all later tabs are disabled, and refresh preserves this state.
4. Answer every About You question. On the final answer, verify Review becomes the loading current step and later tabs remain disabled; refresh once.
5. In Review, accept/correct/remove every known case. For a sealed failure, enter a Creator correction and why; verify a new Version is created and Review remains loading.
6. When Review is release-ready, open Brief, save at least one required question, then open Complete.
7. Before the final **Publish product** command, verify the candidate digest, BriefSpec and Product identity. Publish only as an explicit release decision.

Current evidence: real Versions 2–5, About You answers, Review accept/correction, sealed held-out correction, and refresh persistence were exercised on Product `1650bef0-5eda-4eee-a18e-f359a25f0598`. Version 5 provider execution remains in progress at the time of this record; final Publish is therefore not yet claimed.

## 4. Context Intake UAT checklist

1. Start `begin_browser_login` and open the returned authorization URL in the signed-in Hatch browser.
2. Confirm the consent page lists only Product and Product Files capabilities; approve it.
3. Finish the local callback and verify the creator identity without exposing the token.
4. Review a candidate Markdown artifact from approved creator context. Upload only with `creator_approved=true` and provenance metadata.
5. Read back the returned Product File receipt and verify `product_id`, `artifact_id`, bytes and SHA-256.

Observed in this UAT: Maya Chen OAuth/PKCE succeeded; `context-intake-uat.md` was uploaded to the Product Files of the Product above and read back with the same artifact and digest. The response explicitly confirmed that no Version or Run was changed.

## 5. Buyer Desktop UAT (pending)

Use a real buyer account with entitlement to the published Product:

1. Open the acquired Product in the real Hatch Desktop build.
2. Read the published BriefSpec and fill required answers.
3. Submit once; verify immutable BriefSnapshot persistence and idempotent retry.
4. Confirm Conversation/Task creation, Agent start, and runtime instructions.
5. Refresh/reopen Desktop and verify the same Task and BriefSnapshot remain available read-only.

Do not use a fixture, preview bundle, synthetic entitlement or fake success state as evidence for this section.

## 6. Evidence levels

| Evidence | Meaning |
| --- | --- |
| Unit/component | Contract or rendering behavior only |
| Focused HTTP/integration | Real server modules and persistence boundaries, usually test-controlled dependencies |
| Production browser | Signed-in UI plus deployed backend/provider and durable state |
| Desktop OS UAT | Real Hatch Desktop build, entitlement, native bridge and Agent |

Only the last two levels can close product UAT. Provider quota, signed browser OAuth, production Postgres/Object Storage and Desktop OS state must be reported separately from green unit tests.

Implementation note: Product mutation CAS compares the Postgres timestamp at the API's millisecond precision; hidden database microseconds must not turn a freshly read Product into a false `version_conflict`.
