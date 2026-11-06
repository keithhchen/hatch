// Developer guide as data: one list of methods, each a list of steps with its
// code, and one copy table per locale. DevelopersGuide joins them for a locale;
// DevelopersPage renders any guide, so adding a method or a language adds data only.
export const ORIGIN = "https://gethatchapp.com";
export const KEYS_PATH = "/studio/api-keys";
export const TARBALL_URL = `${ORIGIN}/downloads/hatch-cli.tgz`;

const sh = (text) => ({ lang: "sh", text });
const json = (text) => ({ lang: "json", text });
const toml = (text) => ({ lang: "toml", text });

const AUTH = `-H "Authorization: Bearer $HATCH_API_KEY"`;
const JSON_HEADER = `-H "Content-Type: application/json"`;
const PRODUCT_URL = `${ORIGIN}/v1/creator/products/$PRODUCT_ID`;
const WORKER_URL = `${PRODUCT_URL}/workers/research`;

const INSTALL = sh(`npm install -g ${TARBALL_URL}`);

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
      { id: "chat", code: [sh(`curl -s -X POST "${WORKER_URL}/messages?wait=60" ${AUTH} ${JSON_HEADER} \\\n  -d '{"content":"Summarize what we know about the expert"}' \\\n  | jq '{status, reply}'`)] },
      {
        id: "history",
        code: [
          sh(`curl -s "${WORKER_URL}/messages?after=$MESSAGE_ID" ${AUTH}`),
          json(`{\n  "status": "idle | running | failed",\n  "messages": [\n    { "id": "…", "role": "user | assistant", "text": "…", "created_at": "…" }\n  ]\n}`)
        ]
      },
      { id: "events", code: [sh(`curl -N ${WORKER_URL}/events ${AUTH}`)] },
      { id: "stop", code: [sh(`curl -s -X POST ${WORKER_URL}/stop ${AUTH} ${JSON_HEADER} -d '{}'`)] },
      { id: "assistant", code: [sh(`curl -s -X POST "${ORIGIN}/v1/creator/assistant/conversation/messages?wait=60" ${AUTH} ${JSON_HEADER} \\\n  -d '{"content":"What needs my attention?"}'`)] }
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
  }
]);

const STEPS = (entries) => Object.freeze(Object.fromEntries(entries.map(([id, title, note]) => [id, Object.freeze({ title, note })])));

const COPY = Object.freeze({
  en: {
    documentTitle: "Developers · Hatch",
    homeLabel: "Hatch home",
    title: "Developers",
    methodsLabel: "Integration method",
    tabs: { cli: "CLI", api: "HTTP API", mcp: "MCP" },
    copy: "Copy", copied: "Copied", keys: "Open API keys",
    steps: {
      cli: STEPS([
        ["install", "Install the CLI", "Node 20 or newer."],
        ["login", "Sign in", "`hatch login` opens the browser. Or create an API key and pipe it in; the key is shown once."],
        ["list", "List your products"],
        ["create", "Create a product"],
        ["ingest", "Ingest links and files", "Up to 50 items and 30 MB of files per call. `--wait` polls every 5 seconds."],
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
        ["files", "Ingest a file", "Inline files total at most 30 MB. `media_type` is optional."],
        ["job", "Check the job", "Job: queued, running, done, failed. Item: pending, ok, partial, failed."],
        ["workers", "Talk to workers"],
        ["chat", "Send a message"],
        ["history", "Read the history"],
        ["events", "Watch events"],
        ["stop", "Stop a worker"],
        ["assistant", "Talk to the Assistant"]
      ]),
      mcp: STEPS([
        ["install", "Install the CLI and sign in", "The MCP server runs locally over stdio and uses the CLI's sign-in."],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["tools", "Tools", "Sign-in, sign-out and API keys stay human actions in the CLI. There is no remote (HTTP) MCP yet, so chat apps without a terminal cannot connect; use the HTTP API."],
        ["workers", "Talk to workers"],
        ["skill", "Agent skill", "Teaches coding agents to use the CLI."]
      ])
    }
  },
  zh: {
    documentTitle: "开发者 · Hatch",
    homeLabel: "Hatch 首页",
    title: "开发者",
    methodsLabel: "接入方式",
    tabs: { cli: "CLI", api: "HTTP API", mcp: "MCP" },
    copy: "复制", copied: "已复制", keys: "打开 API 密钥",
    steps: {
      cli: STEPS([
        ["install", "安装 CLI", "需要 Node 20 或更高版本。"],
        ["login", "登录", "`hatch login` 会打开浏览器。也可以创建 API 密钥后通过管道传入；密钥只显示一次。"],
        ["list", "列出你的产品"],
        ["create", "创建产品"],
        ["ingest", "导入链接和文件", "每次最多 50 项、文件合计 30 MB。`--wait` 每 5 秒轮询一次。"],
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
        ["files", "导入文件", "内联文件合计最多 30 MB。`media_type` 可选。"],
        ["job", "查看任务", "任务：queued、running、done、failed。条目：pending、ok、partial、failed。"],
        ["workers", "和 Worker 对话"],
        ["chat", "发送消息"],
        ["history", "读取历史"],
        ["events", "订阅事件"],
        ["stop", "停止 Worker"],
        ["assistant", "和助理对话"]
      ]),
      mcp: STEPS([
        ["install", "安装 CLI 并登录", "MCP 服务在本机通过 stdio 运行，使用 CLI 的登录状态。"],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["tools", "工具", "登录、登出和 API 密钥仍需由人在 CLI 中操作。目前没有远程（HTTP）MCP，没有终端的聊天应用无法连接；请使用 HTTP API。"],
        ["workers", "和 Worker 对话"],
        ["skill", "Agent skill", "让编程 Agent 学会使用 CLI。"]
      ])
    }
  },
  ja: {
    documentTitle: "開発者 · Hatch",
    homeLabel: "Hatch ホーム",
    title: "開発者",
    methodsLabel: "連携方法",
    tabs: { cli: "CLI", api: "HTTP API", mcp: "MCP" },
    copy: "コピー", copied: "コピーしました", keys: "API キーを開く",
    steps: {
      cli: STEPS([
        ["install", "CLI をインストール", "Node 20 以上が必要です。"],
        ["login", "ログイン", "`hatch login` でブラウザが開きます。API キーを作成してパイプで渡すこともできます。キーは一度だけ表示されます。"],
        ["list", "プロダクトを一覧表示"],
        ["create", "プロダクトを作成"],
        ["ingest", "リンクとファイルを取り込む", "1 回あたり最大 50 件、ファイルは合計 30 MB までです。`--wait` は 5 秒ごとに確認します。"],
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
        ["files", "ファイルを取り込む", "インラインのファイルは合計 30 MB までです。`media_type` は省略できます。"],
        ["job", "ジョブを確認", "ジョブ: queued、running、done、failed。項目: pending、ok、partial、failed。"],
        ["workers", "ワーカーと話す"],
        ["chat", "メッセージを送る"],
        ["history", "履歴を読む"],
        ["events", "イベントを購読"],
        ["stop", "ワーカーを停止"],
        ["assistant", "アシスタントと話す"]
      ]),
      mcp: STEPS([
        ["install", "CLI をインストールしてログイン", "MCP サーバーはローカルで stdio 経由で動作し、CLI のログイン状態を使います。"],
        ["claude", "Claude Code"],
        ["codex", "Codex"],
        ["tools", "ツール", "ログイン、ログアウト、API キーは引き続き人が CLI で操作します。リモート（HTTP）MCP はまだなく、ターミナルのないチャットアプリからは接続できません。HTTP API を使ってください。"],
        ["workers", "ワーカーと話す"],
        ["skill", "エージェントスキル", "コーディングエージェントに CLI の使い方を教えます。"]
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
      label: this.copy.tabs[method.id],
      steps: method.steps.map((step, index) => ({ ...step, number: index + 1, ...this.copy.steps[method.id][step.id] }))
    }));
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
