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

## 修复后实测

- 本地重新执行 `HATCH_PERSISTENT_SESSION=0 npm run build:app`，exit 0。产品代码为 `f65564d9e94032962eae876fc618abf2ef09a801`，包含 npm/npx 修复；构建期间仅追加测试，没有修改产品代码。仍是本地 ad-hoc 产品构建，不是 tag 发布产物。
- 启动后经 `ps` 核实实际进程来自上述新 app。真实账户的 B 历史正常加载，输入框为空；切到 A 后恢复 `UAT-0.1.31-draft-A（不发送）`。
- B 输入 `UAT-0.1.31-draft-B（不发送）`，再回 A，仍是 A 的原值；未触发 renderer 错误。
- 退出 app，再打开：A 原值恢复，切 B 后 B 原值恢复。两份草稿均通过 UI 清空；全程未发送标记、未修改已有聊天历史。
- 两个会话完成握手后都显示 `Creator | 孙学-机会操盘顾问`。不能据此证明不同 Agent presentation 的切换；该项仍只有自动化证据。
- 实际新 `.app/Contents/Resources/runtime/node/bin/npm` 和 `npx` 在 `env -i PATH=/nonexistent` 下分别返回 `10.9.8`、exit 0，证明打包后入口可执行；不是仅检查源码目录。
- 追加真实 assistant-ui composer + 消息列表共同切换测试后，renderer 全量 40 个文件、296 项通过。

## 尚未证明

滚动位置、不同 Agent 标题、运行中并发切换、实际消息目标、图片提交、Kimi 看图及 Office 端到端不在本次草稿测试证明范围内。Windows 实机、完整 CI/CD 和 tag 发布仍未完成；不得描述为完整 UAT 通过。
