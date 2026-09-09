# Factory 已移入 Creator Dashboard

产品入口：`/studio/factory`。使用 Dashboard 的 Creator 登录。

- 页面：`creator-dashboard/src/FactoryAgents.jsx`
- API：`/v1/creator/factory-agents/*`，由 Dashboard BFF 转发至认证后的 Registry。
- Agent runtime、工具与文件：`runtime-server/src/factoryAgents/`
- System Prompts：`runtime-server/prompts/factory-agents/`

不再启动独立 Workbench。旧实验数据位于 `runtime-server/.factory-workbench/`，未删除；它们不是其他 Creator 的共享数据。新的会话存于既有 Factory 持久化目录的 `agent-chats/<creator-id>/`。

构建使用 `npm --prefix creator-dashboard run build` 与 `npm --prefix runtime-server run build`。线上部署还需要 Registry 的 Kimi 与 Tavily 凭据配置；API 未部署或服务缺失时显示实际错误。
