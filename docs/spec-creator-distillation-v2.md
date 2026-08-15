# Creator Distillation：控制面与数据模型

这是 Creator Distillation 的核心 contract。它刻意不包含 Creator presentation、头像/主题色、voice cloning，也不包含 Brief/Complete 服务项目。

## 一、四个真相层

```text
immutable artifacts → append-only event graph → quality-gate assessments
                                      ↓
                              derived state / UI
```

只有前三层是事实；UI 上的 `status`、当前节点、是否可 Release 都必须从它们重算。`state_summary` 可以缓存，但不是第二份 authority。

### 1. Immutable artifacts

原始文件、Markdown projection、Snapshot manifest、LLM output、Eval report、Correction、Corpus bundle 都是 immutable artifact。每个 artifact 必须有：

```ts
{
  artifact_id, task_id, run_id?, revision_id?, kind,
  object_key, sha256, bytes, media_type, created_at
}
```

Postgres 只存索引；内容放在私有 OSS bucket。相同 `artifact_id` 只能再次写入相同 bytes；不能覆盖或删除。Task soft-delete 不删除 artifact。

### 2. Event graph

事件是有向图，不是普通日志：

```ts
{
  id, event_key, sequence, task_id, run_id, revision_id?,
  type, node?, actor, parent_event_ids[], artifact_ids[], payload, occurred_at
}
```

每条边都指向同一 Task 的既有事件；`artifact_ids` 必须已经在 artifact index 中。`event_key` 做幂等，重复投递返回原事件。Payload 只放 host-owned metadata 和 digest/ref，不放原文、Creator answer 或 provider exception。

### 3. Quality gates

Gate 不是节点状态，而是不可变 assessment：

```ts
{
  id, gate_key, task_id, run_id, revision_id,
  name: schema | development | regression | heldout | completeness | release,
  critical, status: pending | passed | failed | blocked,
  evidence_artifact_ids[], reason?, assessed_at
}
```

同一个 `gate_key` 可以有多次 assessment；derived state 只取最新一次。Release 要求所有 critical gates 的最新 assessment 都是 `passed`，且 held-out 必须是当前 revision 的 sealed artifact。

## 二、业务实体

```text
Task (one Creator, one immutable name, one eventual Product)
  └─ DistillationRun (stable lineage; exactly one per Task)
       └─ RunRevision 1 → RunRevision 2 → …
```

```ts
Task {
  id, creator_id, name, brief, product_id, status: active | deleted,
  run_id?, latest_revision_id?, created_at, updated_at, deleted_at?
}

DistillationRun {
  id, task_id, creator_id, product_id, created_at
}

RunRevision {
  id, run_id, task_id, revision,
  source_snapshot_id, parent_revision_id?, created_at
}
```

新上传材料不会创建第二个 Task/Run；Creator 从同一个 Source Library 再次启动时创建新的 RunRevision，固定新的 Snapshot，并保留 parent revision。旧 revision 永远绑定旧 Snapshot。

## 三、Source Library

Source Library 是 Task 的独立页面和存储区域，可以多次本地上传；不接受 URL 或粘贴文本。创建 RunRevision 时自动锁定 Snapshot，锁定后不能追加文件。

```text
local upload → projection → Source Library
                           └─ start revision → immutable Snapshot
```

- PDF、DOCX、XLSX/XLS、CSV/TSV、TXT、Markdown、JSON、HTML：先转 `text/markdown`。
- PNG/JPG/WEBP：保留原生 image projection，交给 Kimi K2.6 的 multimodal input。
- Original、projection、Snapshot manifest 都保留；模型读取的是 Snapshot 引用解析出的 projection，不读取本地路径。

## 四、节点与回退

节点可以按实现拆分，但数据模型不依赖固定 UI step：

```text
intake → evidence → questions/calibration → corpus
      → development → regression → sealed held-out → release
```

任何节点都可以产生 `node_failed`、`correction_requested` 或 gate failure。Creator correction 必须先形成 Correction artifact 并产生 `correction_submitted`，才允许继续编译。自动边界检测和 Creator 手动打回都走同一条 event edge；回退不改写旧事件，只创建新的 revision/assessment。

Corpus 的语义输入保持窄：

```text
Corpus vN-1 + current-loop feedback + cumulative Regression Set → Corpus vN
```

Development failure 进入 Regression；Held-out failure 晋升 Regression，并要求新的 Creator-answered held-out。历史 calibration 只用于审计，不全部重新塞回 prompt。

## 五、Derived state

`derive(task_id)` 扫描事件和最新 gates，输出：

```ts
{
  current_revision_id?, current_node?, node_status,
  gates, critical_gate_failures[], correction_required,
  latest_release?,
  status: not_started | running | waiting_for_creator |
          needs_correction | ready | released
}
```

派生规则：

- 有未提交 correction 或 critical gate failure → `needs_correction`；
- 有 Creator question request → `waiting_for_creator`；
- 当前 revision 所有 required gates 通过 → `ready`；
- 有 immutable Release → `released`。

## 六、Release

Candidate approval 与 Product publish/open 是同一个 `Release` command，不做两个按钮或两个 authority。Release 记录 candidate/revision/corpus digest，并在 Registry CAS 成功后产生 `release_created` event；失败只产生失败事件，不能移动 live pointer。

## 七、持久化边界

Postgres：Task、Run、RunRevision、Node execution、event graph、gate assessments、Release、artifact index、幂等/lease/version。

OSS bucket `hatch-creator-distillation-1771409462189426`（private、versioning enabled）：原始文件、Markdown projection、Snapshot、LLM 输出、Eval report、Correction、Corpus bundle、trace。运行身份是 ECS `HatchRuntimeRole`，仅对该 bucket 有 Put/Get/List，无 Delete。

## 八、最小接口

```text
POST   /v1/creator/tasks
GET    /v1/creator/tasks
GET    /v1/creator/tasks/:id/graph
DELETE /v1/creator/tasks/:id                 # soft delete

POST   /v1/creator/source-documents          # local bytes only
GET    /v1/creator/source-documents?task_id=…
POST   /v1/creator/source-snapshots

POST   /v1/creator/factory-runs               # task + document ids → new revision
GET    /v1/creator/factory-runs/:id
POST   /v1/creator/factory-runs/:id/retry
POST   /v1/creator/factory-runs/:id/release  # one approval + publish command
```

所有 mutation 都要求 authenticated ownership、optimistic version 和 idempotency key。没有 graph/artifact/gate 证据时，服务必须返回 unavailable/failed，而不是用本地 fake state 补齐。
