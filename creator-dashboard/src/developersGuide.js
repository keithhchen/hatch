// Developer guide as data: one list of methods, each a list of steps with its
// code, and one copy table per locale. DevelopersGuide joins them for a locale;
// DevelopersPage renders any guide, so adding a method or a language adds data only.
export const ORIGIN = "https://gethatchapp.com";
export const KEYS_PATH = "/studio/settings#api-keys";
export const TARBALL_URL = `${ORIGIN}/downloads/hatch-cli.tgz`;

const sh = (text) => ({ lang: "sh", text });
const json = (text) => ({ lang: "json", text });
const toml = (text) => ({ lang: "toml", text });

const AUTH = `-H "Authorization: Bearer $HATCH_API_KEY"`;
const JSON_HEADER = `-H "Content-Type: application/json"`;
const PRODUCT_URL = `${ORIGIN}/v1/creator/products/$PRODUCT_ID`;
const WORKER_URL = `${PRODUCT_URL}/workers/research`;

const INSTALL = sh(`npm install -g ${TARBALL_URL}`);

const RESPONSES_URL = `${ORIGIN}/responses/v1`;
const py = (text) => ({ lang: "python", text });
const js = (text) => ({ lang: "javascript", text });
const plain = (text) => ({ lang: "text", text });
const CLIENT_PY = `import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url="${RESPONSES_URL}", api_key=os.environ["HATCH_API_KEY"])`;
const CLIENT_JS = `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${RESPONSES_URL}", apiKey: process.env.HATCH_API_KEY });`;

const RESPONSES = {
  id: "responses",
  group: "responses",
  path: "/developers/responses",
  steps: [
    { id: "key", code: [sh("export HATCH_API_KEY=...")], link: KEYS_PATH },
    { id: "sdk", code: [sh("pip install openai"), py(CLIENT_PY), sh("npm i openai"), js(CLIENT_JS)] },
    {
      id: "models",
      code: [
        py(`for model in client.models.list():\n    print(model.id)`),
        js(`for await (const model of client.models.list()) console.log(model.id);`),
        sh(`curl -s ${RESPONSES_URL}/models ${AUTH} \\\n  | jq '.data[] | {id, task_brief}'`),
        json(`{\n  "id": "hatch:<product_id>",\n  "object": "model",\n  "task_brief": { "fields": [{ "id": "goal", "label": "Goal", "required": true }] }\n}`)
      ]
    },
    {
      id: "conversation",
      code: [
        py(`conversation = client.conversations.create(\n    metadata={"title": "Launch plan"},\n    extra_body={"model": "hatch:<product_id>", "task_brief": {"goal": "Plan a launch"}},\n)\nprint(conversation.id)`),
        js(`const conversation = await client.conversations.create({\n  model: "hatch:<product_id>",\n  task_brief: { goal: "Plan a launch" },\n  metadata: { title: "Launch plan" },\n});`),
        sh(`CONVERSATION_ID=$(curl -s -X POST ${RESPONSES_URL}/conversations ${AUTH} ${JSON_HEADER} \\\n  -d '{"model":"hatch:<product_id>","task_brief":{"goal":"Plan a launch"},"metadata":{"title":"Launch plan"}}' \\\n  | jq -r '.id')`),
        sh(`curl -s ${RESPONSES_URL}/conversations/$CONVERSATION_ID ${AUTH}\ncurl -s "${RESPONSES_URL}/conversations?model=hatch:<product_id>&limit=20" ${AUTH}\ncurl -s ${RESPONSES_URL}/conversations/$CONVERSATION_ID/items ${AUTH}\ncurl -s -X DELETE ${RESPONSES_URL}/conversations/$CONVERSATION_ID ${AUTH}`)
      ]
    },
    {
      id: "respond",
      code: [
        py(`response = client.responses.create(\n    model="hatch:<product_id>",\n    conversation=conversation.id,\n    input="Draft the announcement",\n)\nprint(response.status, response.output_text, response.usage.total_tokens)`),
        js(`const response = await client.responses.create({\n  model: "hatch:<product_id>",\n  conversation: conversation.id,\n  input: "Draft the announcement",\n});\nconsole.log(response.status, response.output_text, response.usage.total_tokens);`),
        sh(`curl -s -X POST ${RESPONSES_URL}/responses ${AUTH} ${JSON_HEADER} -H "Idempotency-Key: $(uuidgen)" \\\n  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":"Draft the announcement"}' \\\n  | jq '{id, status, output_text, usage}'`),
        py(`client.responses.create(\n    model="hatch:<product_id>",\n    conversation=conversation.id,\n    input="Draft the announcement",\n    extra_headers={"Idempotency-Key": "launch-1"},\n)`),
        sh(`curl -s -X POST ${RESPONSES_URL}/responses ${AUTH} ${JSON_HEADER} \\\n  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":"Draft the announcement","background":true,"include":["hatch.tool_calls"]}'\ncurl -s ${RESPONSES_URL}/responses/$RESPONSE_ID ${AUTH}\ncurl -s -X POST ${RESPONSES_URL}/responses/$RESPONSE_ID/cancel ${AUTH}`)
      ]
    },
    {
      id: "stream",
      code: [
        py(`stream = client.responses.create(\n    model="hatch:<product_id>",\n    conversation=conversation.id,\n    input="Draft the announcement",\n    stream=True,\n)\nfor event in stream:\n    if event.type == "response.output_text.delta":\n        print(event.delta, end="", flush=True)`),
        js(`const stream = await client.responses.create({\n  model: "hatch:<product_id>",\n  conversation: conversation.id,\n  input: "Draft the announcement",\n  stream: true,\n});\nfor await (const event of stream) {\n  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);\n}`),
        sh(`curl -N -X POST ${RESPONSES_URL}/responses ${AUTH} ${JSON_HEADER} \\\n  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":"Draft the announcement","stream":true}'\ncurl -N "${RESPONSES_URL}/responses/$RESPONSE_ID?stream=true" ${AUTH}`),
        plain(`response.created  response.in_progress\nresponse.output_item.added  response.content_part.added\nresponse.output_text.delta  response.output_text.done\nresponse.content_part.done  response.output_item.done\nresponse.completed | response.failed | response.incomplete\nerror`)
      ]
    },
    {
      id: "attachments",
      code: [
        py(`import base64\n\nphoto = base64.b64encode(open("photo.png", "rb").read()).decode()\nnotes = base64.b64encode(open("notes.pdf", "rb").read()).decode()\nresponse = client.responses.create(\n    model="hatch:<product_id>",\n    conversation=conversation.id,\n    input=[{\n        "role": "user",\n        "content": [\n            {"type": "input_text", "text": "Compare these"},\n            {"type": "input_image", "image_url": f"data:image/png;base64,{photo}"},\n            {"type": "input_file", "filename": "notes.pdf", "file_data": f"data:application/pdf;base64,{notes}"},\n        ],\n    }],\n)`),
        js(`import { readFileSync } from "node:fs";\n\nconst photo = readFileSync("photo.png").toString("base64");\nconst notes = readFileSync("notes.pdf").toString("base64");\nconst response = await client.responses.create({\n  model: "hatch:<product_id>",\n  conversation: conversation.id,\n  input: [{\n    role: "user",\n    content: [\n      { type: "input_text", text: "Compare these" },\n      { type: "input_image", image_url: "data:image/png;base64," + photo },\n      { type: "input_file", filename: "notes.pdf", file_data: "data:application/pdf;base64," + notes },\n    ],\n  }],\n});`),
        sh(`curl -s -X POST ${RESPONSES_URL}/responses ${AUTH} ${JSON_HEADER} \\\n  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":[{"role":"user","content":[{"type":"input_text","text":"Describe this"},{"type":"input_image","image_url":"data:image/png;base64,'"$(base64 < photo.png | tr -d '\\n')"'"}]}]}'`)
      ]
    },
    {
      id: "files",
      code: [
        py(`file = client.files.create(file=open("notes.pdf", "rb"), purpose="user_data")\nresponse = client.responses.create(\n    model="hatch:<product_id>",\n    conversation=conversation.id,\n    input=[{\n        "role": "user",\n        "content": [\n            {"type": "input_text", "text": "Summarise this"},\n            {"type": "input_file", "file_id": file.id},\n        ],\n    }],\n)`),
        js(`import { createReadStream } from "node:fs";\n\nconst file = await client.files.create({ file: createReadStream("notes.pdf"), purpose: "user_data" });\nconst response = await client.responses.create({\n  model: "hatch:<product_id>",\n  conversation: conversation.id,\n  input: [{\n    role: "user",\n    content: [\n      { type: "input_text", text: "Summarise this" },\n      { type: "input_file", file_id: file.id },\n    ],\n  }],\n});`),
        sh(`curl -s -X POST ${RESPONSES_URL}/files ${AUTH} -F purpose=user_data -F file=@notes.pdf\ncurl -s -X POST ${RESPONSES_URL}/responses ${AUTH} ${JSON_HEADER} \\\n  -d '{"model":"hatch:<product_id>","conversation":"'"$CONVERSATION_ID"'","input":[{"role":"user","content":[{"type":"input_text","text":"Summarise this"},{"type":"input_file","file_id":"'"$FILE_ID"'"}]}]}'`)
      ]
    },
    {
      id: "continue",
      code: [
        py(`followup = client.responses.create(\n    model="hatch:<product_id>",\n    previous_response_id=response.id,\n    input="Shorter, please",\n)\nitems = client.conversations.items.list(conversation.id)`),
        js(`const followup = await client.responses.create({\n  model: "hatch:<product_id>",\n  previous_response_id: response.id,\n  input: "Shorter, please",\n});`),
        sh(`curl -s -X POST ${RESPONSES_URL}/responses ${AUTH} ${JSON_HEADER} \\\n  -d '{"model":"hatch:<product_id>","task_brief":{"goal":"Plan a launch"},"input":""}'`)
      ]
    },
    {
      id: "errors",
      code: [
        json(`{ "error": { "message": "…", "type": "conflict_error", "param": null, "code": "conversation_busy" } }`),
        plain(`401  invalid_api_key\n404  model_not_found  conversation_not_found  response_not_found\n409  conversation_busy  idempotency_key_reused\n400  task_brief_required  unsupported_parameter\n413  file_too_large\n415  unsupported_file_type\n429  rate_limit_exceeded  insufficient_quota (usage_cap_exceeded)\n500  internal_error\n503  service_unavailable`)
      ]
    }
  ]
};

export const METHODS = Object.freeze([
  {
    id: "cli",
    path: "/developers/cli",
    steps: [
      { id: "install", code: [INSTALL, sh("hatch --help")] },
      { id: "login", code: [sh("hatch login\nhatch whoami"), sh(`printf %s "$HATCH_API_KEY" | hatch login --api-key-stdin`)], link: KEYS_PATH },
      { id: "list", code: [sh("hatch products list")] },
      { id: "create", code: [sh(`hatch products create --name "My agent" --promise "What it does for customers"`)] },
      { id: "ingest", code: [sh(`hatch ingest <product-id> https://example.com/post ./notes.pdf --context "Why these sources" --wait`)] },
      { id: "job", code: [sh("hatch ingest status <product-id> <job-id>\nhatch ingest list <product-id>")] },
      { id: "workers", code: [sh("hatch workers <product-id>")] },
      { id: "chat", code: [sh(`hatch chat <product-id> research "Summarize what we know about the expert" --wait`)] },
      { id: "history", code: [sh("hatch history <product-id> research --after <message-id>")] },
      { id: "stop", code: [sh("hatch stop <product-id> research")] },
      { id: "assistant", code: [sh(`hatch assistant "What needs my attention?" --wait\nhatch assistant history`)] }
    ]
  },
  {
    id: "api",
    path: "/developers/api",
    steps: [
      { id: "key", code: [sh(`export HATCH_API_KEY=...\ncurl -s ${ORIGIN}/v1/auth/me ${AUTH}`)], link: KEYS_PATH },
      { id: "list", code: [sh(`curl -s ${ORIGIN}/v1/creator/products ${AUTH} \\\n  | jq '.products[] | {product_id, name, status}'`)] },
      { id: "create", code: [sh(`PRODUCT_ID=$(curl -s -X POST ${ORIGIN}/v1/creator/products ${AUTH} ${JSON_HEADER} \\\n  -d '{"name":"My agent","promise":"What it does for customers"}' \\\n  | jq -r '.product.product_id')`)] },
      { id: "update", code: [sh(`curl -s ${PRODUCT_URL} ${AUTH}`), sh(`curl -s -X PATCH ${PRODUCT_URL} ${AUTH} ${JSON_HEADER} \\\n  -d '{"promise":"A sharper promise","expected_updated_at":"<updated_at from the GET>"}'`)] },
      { id: "listing", code: [sh(`curl -s -X PUT ${PRODUCT_URL}/listing ${AUTH} ${JSON_HEADER} \\\n  -d '{"listed":false}'`)] },
      { id: "links", code: [sh(`JOB_ID=$(curl -s -X POST ${PRODUCT_URL}/ingest ${AUTH} ${JSON_HEADER} \\\n  -d '{"items":[{"url":"https://example.com/post"}],"context":"Why these sources"}' \\\n  | jq -r '.job.id')`)] },
      { id: "files", code: [sh(`{ printf '{"items":[{"name":"notes.pdf","media_type":"application/pdf","content_base64":"'\n  base64 -i notes.pdf | tr -d '\\n'\n  printf '"}]}'; } \\\n  | curl -s -X POST ${PRODUCT_URL}/ingest ${AUTH} ${JSON_HEADER} --data-binary @-`)] },
      {
        id: "job",
        code: [
          sh(`curl -s ${PRODUCT_URL}/ingest/$JOB_ID ${AUTH} | jq '.job | {status, items}'\ncurl -s ${PRODUCT_URL}/ingest ${AUTH}`),
          json(`{\n  "job": {\n    "id": "…",\n    "product_id": "…",\n    "status": "queued | running | done | failed",\n    "items": [\n      { "id": "…", "input": "…", "status": "pending | ok | partial | failed", "markdown_path": "…", "original_ref": "…", "error": "…" }\n    ],\n    "created_at": "…",\n    "updated_at": "…",\n    "error": "…"\n  }\n}`)
        ]
      },
      { id: "workers", code: [sh(`curl -s ${PRODUCT_URL}/workers ${AUTH} \\\n  | jq '.workers[] | {id, availability, status}'`)] },
      { id: "chat", code: [sh(`curl -s -X POST "${WORKER_URL}/messages?wait=60" ${AUTH} ${JSON_HEADER} -H "Idempotency-Key: $(uuidgen)" \\\n  -d '{"content":"Summarize what we know about the expert"}' \\\n  | jq '{status, reply}'`)] },
      {
        id: "history",
        code: [
          sh(`curl -s "${WORKER_URL}/messages?after=$MESSAGE_ID" ${AUTH}`),
          json(`{\n  "status": "idle | running | failed",\n  "messages": [\n    { "id": "…", "role": "user | assistant", "text": "…", "created_at": "…" }\n  ]\n}`)
        ]
      },
      { id: "events", code: [sh(`curl -N ${WORKER_URL}/events ${AUTH}`)] },
      { id: "stop", code: [sh(`curl -s -X POST ${WORKER_URL}/stop ${AUTH} ${JSON_HEADER} -d '{}'`)] },
      { id: "assistant", code: [sh(`curl -s -X POST "${ORIGIN}/v1/creator/assistant/conversation/messages?wait=60" ${AUTH} ${JSON_HEADER} -H "Idempotency-Key: $(uuidgen)" \\\n  -d '{"content":"What needs my attention?"}'`)] }
    ]
  },
  {
    id: "mcp",
    path: "/developers/mcp",
    steps: [
      { id: "install", code: [INSTALL, sh("hatch login")] },
      { id: "claude", code: [sh("claude mcp add hatch -- hatch mcp")] },
      { id: "codex", code: [toml(`# ~/.codex/config.toml\n[mcp_servers.hatch]\ncommand = "hatch"\nargs = ["mcp"]`)] },
      { id: "tools", code: [sh("whoami\nproducts_list  products_show  products_create  products_update  products_unlist\ningest_submit  ingest_status  ingest_list")] },
      { id: "workers", code: [sh("workers_list  worker_send  worker_history  worker_stop\nassistant_send  assistant_history")] },
      { id: "skill", code: [sh("hatch install-skill -g")] }
    ]
  },
  RESPONSES
]);

const STEPS = (entries) => Object.freeze(Object.fromEntries(entries.map(([id, title, note]) => [id, Object.freeze({ title, note })])));

const COPY = Object.freeze({
  en: {
    documentTitle: "Developers · Hatch",
    homeLabel: "Hatch home",
    title: "Developers",
    scope: "Hatch has two APIs. The Studio API creates and manages your products. The Responses API chats with your live products from your own code, through the OpenAI SDKs.",
    apiLabel: "API",
    methodsLabel: "Integration method",
    tabs: { cli: "CLI", api: "HTTP API", mcp: "MCP", responses: "Responses API" },
    groups: { studio: "Studio API", responses: "Responses API" },
    copy: "Copy", copied: "Copied", keys: "Open API keys", createKey: "Create an API key in Studio Settings",
    steps: {
      cli: STEPS([
        ["install", "Install the CLI", "Node 20 or newer."],
        ["login", "Sign in", "`hatch login` asks whether to sign in with the browser or paste an API key. Scripts pipe a key in; the key is shown once."],
        ["list", "List your products"],
        ["create", "Create a product"],
        ["ingest", "Ingest links and files", "Up to 50 items and 50 MB of files per call. `--wait` polls every 5 seconds."],
        ["job", "Check the job"],
        ["workers", "Talk to workers"],
        ["chat", "Send a message"],
        ["history", "Read the history"],
        ["stop", "Stop a worker"],
        ["assistant", "Talk to the Assistant"]
      ]),
      api: STEPS([
        ["key", "Create an API key", "The key is shown once. Send it as a Bearer token."],
        ["list", "List your products"],
        ["create", "Create a product"],
        ["update", "Update a product", "PATCH needs `promise` and `expected_updated_at`, the `updated_at` of the product you read."],
        ["listing", "Unlist or list a product"],
        ["links", "Ingest links", "Returns 202 with a job. Up to 50 items per call; the request body is limited to 32 MB."],
        ["files", "Ingest a file", "Inline files total at most 50 MB. `media_type` is optional."],
        ["job", "Check the job", "Job: queued, running, done, failed. Item: pending, ok, partial, failed."],
        ["workers", "Talk to workers"],
        ["chat", "Send a message"],
        ["history", "Read the history"],
        ["events", "Watch events"],
        ["stop", "Stop a worker"],
        ["assistant", "Talk to the Assistant", "Send an Idempotency-Key to make retries safe; without it a retry may create a duplicate."]
      ]),
      mcp: STEPS([
        ["install", "Install the CLI and sign in", "The MCP server runs locally over stdio and uses the CLI's sign-in."],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["tools", "Tools", "Sign-in, sign-out and API keys stay human actions in the CLI. There is no remote (HTTP) MCP yet, so chat apps without a terminal cannot connect; use the HTTP API."],
        ["workers", "Talk to workers"],
        ["skill", "Agent skill", "Teaches coding agents to use the CLI."]
      ]),
      responses: STEPS([
        ["key", "Get an API key", "The same Hatch API key as the Studio API. Create one in Studio Settings, API keys."],
        ["sdk", "Install the SDK and set the base URL", "The official OpenAI SDKs work unchanged. Base URL: `https://gethatchapp.com/responses/v1`."],
        ["models", "List models", "Each of your live products is a model, `hatch:<product_id>`. `task_brief.fields` lists the Task Brief fields the product asks for."],
        ["conversation", "Start a conversation with the Task Brief", "`task_brief` maps field ids to values; a missing required field returns 400 `task_brief_required`. Only `metadata.title` is supported. A conversation id is all you need afterwards. You can also list conversations, read items, rename (POST) and archive (DELETE)."],
        ["respond", "Send a response", "Without `stream` the request waits up to 90 seconds; if the run is still going it returns `status: in_progress`, so poll `GET /responses/{id}`. `background: true` returns immediately. `include: [\"hatch.tool_calls\"]` adds the Agent's server-side tool calls as `hatch_tool_call` items. An approval appears as `mcp_approval_request`; only denial is supported now. SDKs do not send an Idempotency-Key by default; pass one to make retries safe. A second response while one is running returns 409 `conversation_busy`. Every response carries `usage`; usage is counted per account in Studio, Settings, Usage, and a monthly cap may return 429 `insufficient_quota`."],
        ["stream", "Stream the response", "Server-sent events, with a keep-alive comment every 15 seconds. `GET /responses/{id}?stream=true` re-streams a response."],
        ["attachments", "Send images and files", "`input_image` takes a `data:` or `https:` URL. `input_file` takes `file_data` (a data URL) with `filename`; or pass a public https URL as `file_url`."],
        ["files", "Upload a file once, use it by id", "`client.files.create` sends the file as multipart (`purpose` is accepted and ignored). Use the returned `file_id` in `input_image` or `input_file`. Files are private to your account: images up to 20 MB, other files up to 50 MB. List with `GET /files`, read with `GET /files/{id}` and `GET /files/{id}/content`, remove with `DELETE /files/{id}`. An unknown or deleted id returns 404 `file_not_found`; a larger file returns 413 `file_too_large`, and a type Hatch cannot take returns 415 `unsupported_file_type` right away (a corrupt file of a supported type fails when it is used). Each account can store 500 MB; beyond that, 400 `storage_quota_exceeded`, and deleting files frees space."],
        ["continue", "Continue a conversation", "Pass `conversation`, or `previous_response_id` of the latest response in that conversation. An empty `input` on a new conversation starts the run from the Task Brief alone; `task_brief` is only accepted when a new conversation is created."],
        ["errors", "Errors and limits", "Errors use the OpenAI shape. Not supported, returning 400 `unsupported_parameter` with `param`: `instructions`, `tools`, `tool_choice` other than auto, `text.format`, `reasoning`, `max_output_tokens`, system, developer or assistant input roles, `store: false`, and `metadata` other than `title`. Ignored: `temperature`, `top_p`, `user`, `service_tier`. Files: 413 `file_too_large`, 415 `unsupported_file_type`, 404 `file_not_found`, 400 `storage_quota_exceeded` (500 MB per account)."]
      ])
    }
  },
  zh: {
    documentTitle: "开发者 · Hatch",
    homeLabel: "Hatch 首页",
    title: "开发者",
    scope: "Hatch 有两套 API。Studio API 用于创建和管理你的产品；Responses API 让你在自己的代码里通过 OpenAI SDK 与已上线的产品对话。",
    apiLabel: "API",
    methodsLabel: "接入方式",
    tabs: { cli: "CLI", api: "HTTP API", mcp: "MCP", responses: "Responses API" },
    groups: { studio: "Studio API", responses: "Responses API" },
    copy: "复制", copied: "已复制", keys: "打开 API 密钥", createKey: "在 Studio 设置里创建 API 密钥",
    steps: {
      cli: STEPS([
        ["install", "安装 CLI", "需要 Node 20 或更高版本。"],
        ["login", "登录", "`hatch login` 会让你选择浏览器登录或粘贴 API 密钥。脚本可通过管道传入密钥；密钥只显示一次。"],
        ["list", "列出你的产品"],
        ["create", "创建产品"],
        ["ingest", "导入链接和文件", "每次最多 50 项、文件合计 50 MB。`--wait` 每 5 秒轮询一次。"],
        ["job", "查看任务"],
        ["workers", "和 Worker 对话"],
        ["chat", "发送消息"],
        ["history", "读取历史"],
        ["stop", "停止 Worker"],
        ["assistant", "和助理对话"]
      ]),
      api: STEPS([
        ["key", "创建 API 密钥", "密钥只显示一次。以 Bearer token 方式发送。"],
        ["list", "列出你的产品"],
        ["create", "创建产品"],
        ["update", "更新产品", "PATCH 需要 `promise` 和 `expected_updated_at`，即你读取到的产品的 `updated_at`。"],
        ["listing", "取消展示或重新展示产品"],
        ["links", "导入链接", "返回 202 和一个任务。每次最多 50 项；请求体上限 32 MB。"],
        ["files", "导入文件", "内联文件合计最多 50 MB。`media_type` 可选。"],
        ["job", "查看任务", "任务：queued、running、done、failed。条目：pending、ok、partial、failed。"],
        ["workers", "和 Worker 对话"],
        ["chat", "发送消息"],
        ["history", "读取历史"],
        ["events", "订阅事件"],
        ["stop", "停止 Worker"],
        ["assistant", "和助理对话", "发送 Idempotency-Key 可让重试安全；不带它，重试可能产生重复。"]
      ]),
      mcp: STEPS([
        ["install", "安装 CLI 并登录", "MCP 服务在本机通过 stdio 运行，使用 CLI 的登录状态。"],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["tools", "工具", "登录、登出和 API 密钥仍需由人在 CLI 中操作。目前没有远程（HTTP）MCP，没有终端的聊天应用无法连接；请使用 HTTP API。"],
        ["workers", "和 Worker 对话"],
        ["skill", "Agent skill", "让编程 Agent 学会使用 CLI。"]
      ]),
      responses: STEPS([
        ["key", "获取 API 密钥", "与 Studio API 使用同一个 Hatch API 密钥。在 Studio 设置的 API 密钥里创建。"],
        ["sdk", "安装 SDK 并设置 base URL", "官方 OpenAI SDK 无需修改即可使用。Base URL：`https://gethatchapp.com/responses/v1`。"],
        ["models", "列出模型", "你每个已上线的产品都是一个模型，`hatch:<product_id>`。`task_brief.fields` 列出该产品需要的 Task Brief 字段。"],
        ["conversation", "用 Task Brief 开始对话", "`task_brief` 是字段 id 到值的映射；缺少必填字段会返回 400 `task_brief_required`。只支持 `metadata.title`。之后只需要对话 id。你还可以列出对话、读取 items、改名（POST）和归档（DELETE）。"],
        ["respond", "发送 response", "不带 `stream` 时请求最多等待 90 秒；若运行仍在进行，返回 `status: in_progress`，此时轮询 `GET /responses/{id}`。`background: true` 会立即返回。`include: [\"hatch.tool_calls\"]` 会把 Agent 在服务端的工具调用以 `hatch_tool_call` item 返回。审批以 `mcp_approval_request` 出现；目前只支持拒绝。SDK 默认不发送 Idempotency-Key；传入后重试才安全。运行中再发 response 会返回 409 `conversation_busy`。每个 response 都带 `usage`；用量按账号统计，见 Studio 设置的用量页，月度上限可能返回 429 `insufficient_quota`。"],
        ["stream", "流式输出", "Server-sent events，每 15 秒一条 keep-alive 注释。`GET /responses/{id}?stream=true` 可重新流式读取某个 response。"],
        ["attachments", "发送图片和文件", "`input_image` 接受 `data:` 或 `https:` URL。`input_file` 接受带 `filename` 的 `file_data`（data URL）；也可以把公开的 https URL 作为 `file_url` 传入。"],
        ["files", "上传文件，按 id 使用", "`client.files.create` 以 multipart 上传文件（`purpose` 会被接受并忽略）。把返回的 `file_id` 用在 `input_image` 或 `input_file` 中。文件仅你的账号可见：图片最大 20 MB，其他文件最大 50 MB。用 `GET /files` 列出，`GET /files/{id}` 与 `GET /files/{id}/content` 读取，`DELETE /files/{id}` 删除。未知或已删除的 id 返回 404 `file_not_found`；超限返回 413 `file_too_large`，不支持的类型会立即返回 415 `unsupported_file_type`（受支持类型但已损坏的文件会在使用时失败）。每个账号可存储 500 MB，超出返回 400 `storage_quota_exceeded`，删除文件即可释放空间。"],
        ["continue", "继续对话", "传入 `conversation`，或该对话最新 response 的 `previous_response_id`。新对话的 `input` 为空时，仅凭 Task Brief 启动运行；`task_brief` 只在创建新对话时接受。"],
        ["errors", "错误与限制", "错误采用 OpenAI 格式。不支持的参数返回 400 `unsupported_parameter` 并带 `param`：`instructions`、`tools`、非 auto 的 `tool_choice`、`text.format`、`reasoning`、`max_output_tokens`、system/developer/assistant 输入角色、`store: false`，以及 `title` 以外的 `metadata`。会被忽略：`temperature`、`top_p`、`user`、`service_tier`。文件：413 `file_too_large`、415 `unsupported_file_type`、404 `file_not_found`、400 `storage_quota_exceeded`（每个账号 500 MB）。"]
      ])
    }
  },
  ja: {
    documentTitle: "開発者 · Hatch",
    homeLabel: "Hatch ホーム",
    title: "開発者",
    scope: "Hatch には 2 つの API があります。Studio API はプロダクトの作成と管理に、Responses API は公開中のプロダクトと自分のコードから OpenAI SDK で会話するために使います。",
    apiLabel: "API",
    methodsLabel: "連携方法",
    tabs: { cli: "CLI", api: "HTTP API", mcp: "MCP", responses: "Responses API" },
    groups: { studio: "Studio API", responses: "Responses API" },
    copy: "コピー", copied: "コピーしました", keys: "API キーを開く", createKey: "Studio の設定で API キーを作成",
    steps: {
      cli: STEPS([
        ["install", "CLI をインストール", "Node 20 以上が必要です。"],
        ["login", "ログイン", "`hatch login` でブラウザか API キーの貼り付けかを選べます。スクリプトはキーをパイプで渡せます。キーは一度だけ表示されます。"],
        ["list", "プロダクトを一覧表示"],
        ["create", "プロダクトを作成"],
        ["ingest", "リンクとファイルを取り込む", "1 回あたり最大 50 件、ファイルは合計 50 MB までです。`--wait` は 5 秒ごとに確認します。"],
        ["job", "ジョブを確認"],
        ["workers", "ワーカーと話す"],
        ["chat", "メッセージを送る"],
        ["history", "履歴を読む"],
        ["stop", "ワーカーを停止"],
        ["assistant", "アシスタントと話す"]
      ]),
      api: STEPS([
        ["key", "API キーを作成", "キーは一度だけ表示されます。Bearer トークンとして送信します。"],
        ["list", "プロダクトを一覧表示"],
        ["create", "プロダクトを作成"],
        ["update", "プロダクトを更新", "PATCH には `promise` と `expected_updated_at`（読み取ったプロダクトの `updated_at`）が必要です。"],
        ["listing", "公開一覧から外す・戻す"],
        ["links", "リンクを取り込む", "202 とジョブを返します。1 回あたり最大 50 件、リクエスト本文は 32 MB までです。"],
        ["files", "ファイルを取り込む", "インラインのファイルは合計 50 MB までです。`media_type` は省略できます。"],
        ["job", "ジョブを確認", "ジョブ: queued、running、done、failed。項目: pending、ok、partial、failed。"],
        ["workers", "ワーカーと話す"],
        ["chat", "メッセージを送る"],
        ["history", "履歴を読む"],
        ["events", "イベントを購読"],
        ["stop", "ワーカーを停止"],
        ["assistant", "アシスタントと話す", "Idempotency-Key を送るとリトライが安全になります。送らない場合、リトライで重複する可能性があります。"]
      ]),
      mcp: STEPS([
        ["install", "CLI をインストールしてログイン", "MCP サーバーはローカルで stdio 経由で動作し、CLI のログイン状態を使います。"],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["tools", "ツール", "ログイン、ログアウト、API キーは引き続き人が CLI で操作します。リモート（HTTP）MCP はまだなく、ターミナルのないチャットアプリからは接続できません。HTTP API を使ってください。"],
        ["workers", "ワーカーと話す"],
        ["skill", "エージェントスキル", "コーディングエージェントに CLI の使い方を教えます。"]
      ]),
      responses: STEPS([
        ["key", "API キーを取得", "Studio API と同じ Hatch API キーです。Studio の設定、API キーで作成します。"],
        ["sdk", "SDK をインストールして base URL を設定", "公式の OpenAI SDK がそのまま使えます。Base URL: `https://gethatchapp.com/responses/v1`。"],
        ["models", "モデルを一覧表示", "公開中の各プロダクトがモデル `hatch:<product_id>` になります。`task_brief.fields` にそのプロダクトが求める Task Brief の項目が並びます。"],
        ["conversation", "Task Brief で会話を始める", "`task_brief` は項目 id から値へのマップです。必須項目が欠けると 400 `task_brief_required` を返します。サポートするのは `metadata.title` のみです。以降は会話 id だけで足ります。会話の一覧、items の取得、名前変更（POST）、アーカイブ（DELETE）もできます。"],
        ["respond", "response を送る", "`stream` なしの場合、リクエストは最大 90 秒待ちます。まだ実行中なら `status: in_progress` を返すので、`GET /responses/{id}` をポーリングします。`background: true` はすぐに返ります。`include: [\"hatch.tool_calls\"]` で Agent のサーバー側ツール呼び出しが `hatch_tool_call` item として含まれます。承認は `mcp_approval_request` として現れ、現在は拒否のみ対応です。SDK は既定で Idempotency-Key を送りません。渡すとリトライが安全になります。実行中にもう 1 つ response を送ると 409 `conversation_busy` を返します。すべての response に `usage` が付きます。使用量はアカウント単位で、Studio の設定、使用量で確認でき、月間上限に達すると 429 `insufficient_quota` を返すことがあります。"],
        ["stream", "ストリーミング", "Server-sent events で、15 秒ごとに keep-alive コメントが届きます。`GET /responses/{id}?stream=true` で response を再ストリームできます。"],
        ["attachments", "画像とファイルを送る", "`input_image` は `data:` または `https:` の URL を受け付けます。`input_file` は `filename` 付きの `file_data`（data URL）を受け付けます。公開された https URL を `file_url` として渡すこともできます。"],
        ["files", "ファイルを一度アップロードして id で使う", "`client.files.create` はファイルを multipart で送ります（`purpose` は受け付けますが無視されます）。返された `file_id` を `input_image` または `input_file` に使います。ファイルはあなたのアカウント専用です。画像は 20 MB、それ以外は 50 MB まで。`GET /files` で一覧、`GET /files/{id}` と `GET /files/{id}/content` で取得、`DELETE /files/{id}` で削除できます。不明または削除済みの id は 404 `file_not_found`、上限超過は 413 `file_too_large`、対応していない種類は直ちに 415 `unsupported_file_type` を返します（対応する種類で破損したファイルは使用時に失敗します）。アカウントごとの保存容量は 500 MB で、超えると 400 `storage_quota_exceeded` を返します。ファイルを削除すると空きができます。"],
        ["continue", "会話を続ける", "`conversation` か、その会話の最新 response の `previous_response_id` を渡します。新しい会話で `input` が空なら、Task Brief だけで実行を開始します。`task_brief` は新しい会話を作るときだけ受け付けます。"],
        ["errors", "エラーと制限", "エラーは OpenAI 形式です。未対応のパラメータは 400 `unsupported_parameter` と `param` を返します。対象: `instructions`、`tools`、auto 以外の `tool_choice`、`text.format`、`reasoning`、`max_output_tokens`、system / developer / assistant の入力ロール、`store: false`、`title` 以外の `metadata`。無視されるもの: `temperature`、`top_p`、`user`、`service_tier`。ファイル: 413 `file_too_large`、415 `unsupported_file_type`、404 `file_not_found`、400 `storage_quota_exceeded`（アカウントごとに 500 MB）。"]
      ])
    }
  }
});

export const DEVELOPER_LOCALES = Object.freeze(Object.keys(COPY));

/** The guide for one locale: tabs of numbered steps, each step with its code. */
export class DevelopersGuide {
  constructor(methods, copy) {
    this.methods = methods;
    this.copy = copy;
  }

  static forLocale(locale, methods = METHODS, copyByLocale = COPY) {
    return new DevelopersGuide(methods, copyByLocale[locale] ?? copyByLocale.en);
  }

  get tabs() {
    return this.methods.map((method) => ({
      id: method.id,
      path: method.path,
      group: method.group ?? "studio",
      label: this.copy.tabs[method.id],
      steps: method.steps.map((step, index) => ({ ...step, number: index + 1, ...this.copy.steps[method.id][step.id] }))
    }));
  }

  /** The top-level switch: one entry per API, linking to its first tab. */
  get groups() {
    const seen = [];
    for (const tab of this.tabs) if (!seen.some((group) => group.id === tab.group)) seen.push({ id: tab.group, path: tab.path, label: this.copy.groups[tab.group] });
    return seen;
  }

  tab(id) {
    return this.tabs.find((tab) => tab.id === id) ?? this.tabs[0];
  }
}

/** /developers and /developers/<method>; null for any other path. */
export function parseDevelopersRoute(pathname) {
  const segments = String(pathname ?? "").split(/[?#]/)[0].split("/").filter(Boolean);
  if (segments[0] !== "developers" || segments.length > 2) return null;
  const tab = segments[1];
  if (tab === undefined) return { tab: METHODS[0].id };
  return METHODS.some((method) => method.id === tab) ? { tab } : null;
}
