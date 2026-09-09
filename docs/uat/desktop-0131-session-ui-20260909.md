# 0.1.31 本地真实 GUI 复测

## 已观察事实

- 使用真实 Tauri app：`desktop-app/src-tauri/target/release/bundle/macos/Hatch.app`，Info.plist 为 0.1.31，进程路径已核验。未覆盖 `/Applications/Hatch.app`。
- 首次本机构建包含草稿恢复和 Agent presentation 修复，但早于 npm/npx 打包入口修复；不用于证明该入口已修复，也不是 tag 发布产物。
- 真实账号启动后，恢复了此前 0.1.30 测试留下的未发送草稿 `UAT-0.1.30-keyboard-draft-A（不发送）`。替换为 `UAT-0.1.31-draft-A（不发送）`，未点击发送。
- 点击第二个对话后 renderer 报错：`useClientLookup: Index 1 out of bounds (length: 0)`。本次切换未通过验收。

## 根因与修复

`useExternalStoreRuntime` 在窗口组件创建，持有内部 store，并在 effect 更新 adapter；仅将下游 provider 按 Conversation key 重挂载，仍然复用旧 runtime。旧消息索引可在切换时访问新列表。

将该 hook 和 AssistantRuntimeProvider 一起移入 keyed Conversation 边界。它仅是展示适配器，后台 Session 仍由既有 manager 持有，不因导航而重启。

新增使用真实 assistant-ui（没有 mock 消息 store）的 React 集成测试，覆盖 populated A → empty B → A 及同一对话追加消息。renderer 全量 295 项通过。

## 尚未证明

修复后的真实 GUI 切换、草稿恢复、滚动位置和标题仍需重建后复测；图片提交、Kimi 看图及 Office 端到端不在上述测试证明范围内。不得发布为已通过完整 UAT。
