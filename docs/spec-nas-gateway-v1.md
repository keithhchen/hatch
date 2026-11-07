# NAS Gateway Service v1

状态：已部署并完成 HTTP、MCP 和跨主机连通检查

## 1. 服务目标

NAS Gateway 为 Dify、Hatch 等产品提供只读文件访问。调用方通过 HTTP 或
Streamable HTTP MCP 调用统一的五种文件工具：`readdir`、`stat`、`read`、`find` 和 `grep`。

每个产品使用独立的 Bearer 密钥。Gateway 根据密钥识别产品，并将所有路径
限制在该产品配置的 NAS 根目录内。调用方不能选择产品身份或指定 NAS 绝对路径。

## 2. 部署与文件布局

沿用 `content_agent` 当前使用的共享 NAS 挂载约定：

| 位置 | 路径 |
| --- | --- |
| 宿主机 NAS 挂载点 | `/mnt/workspaces` |
| Gateway 容器内挂载点 | `/data/workspaces` |
| Gateway 专属目录 | `/data/workspaces/nas-gateway` |
| 产品目录 | `/data/workspaces/nas-gateway/products/<product_id>` |

容器将宿主机 `/mnt/workspaces` 挂载到 `/data/workspaces`。NAS 连接和挂载
由部署环境负责；Gateway 不管理 NAS 挂载生命周期。产品目录下的文件由外部
流程创建和维护，Gateway 只提供读取能力。

Gateway 使用 SQLite 保存产品访问配置。SQLite 文件放在 Docker 持久卷中，
容器重建后配置仍然保留。数据库文件只允许 Gateway 服务账号访问。文件内容
留在 NAS 上，不复制到 SQLite。

## 3. 产品访问配置

配置表 `product_nas_access`：

| 字段 | 含义 |
| --- | --- |
| `product_id` | 唯一产品标识 |
| `key` | 产品 Bearer 密钥，按已确认的决策以明文保存 |
| `nas_root` | 相对于 `/data/workspaces` 的产品根目录 |
| `enabled` | 是否允许该产品调用 |

每个产品配置必须使用唯一的 `product_id` 和 `key`。示例：

```text
product_id: product_a
key: 由 Gateway 管理员生成的独立随机密钥
nas_root: nas-gateway/products/product_a
enabled: true
```

产品密钥只在配置创建或轮换时交付给对应产品方。认证请求携带
`Authorization: Bearer <product-key>`。Gateway 按完整密钥查找配置；密钥
无效或配置已停用时，不得访问 NAS。

## 4. 路径规则

工具参数中的 `path` 是相对于当前产品 `nas_root` 的 POSIX 路径：

| `path` | 目标 |
| --- | --- |
| `""` | 产品根目录 |
| `"docs"` | 产品根目录中的 `docs` 目录 |
| `"docs/brief.pdf"` | `docs` 目录中的 `brief.pdf` 文件 |

路径使用 `/` 分隔，不包含产品名、挂载路径或开头的 `/`。`readdir`、`stat`、`find` 和 `grep` 支持空路径，表示产品根目录；`read` 要求文件路径。

Gateway 必须拒绝绝对路径、任何 `..` 路径段，以及解析后超出产品根目录的符号
链接。路径解析必须在文件系统操作时继续保证根目录边界，避免符号链接变化造成
越权读取。结果中的路径始终相对于产品根目录。

## 5. 调用接口

HTTP 使用 JSON 请求，并通过产品 Bearer 密钥认证：

```http
POST /v1/tools/{tool}
Authorization: Bearer <product-key>
Content-Type: application/json
```

支持以下路由：

```text
POST /v1/tools/readdir
POST /v1/tools/stat
POST /v1/tools/read
POST /v1/tools/find
POST /v1/tools/grep
```

MCP endpoint 为 `/mcp`，使用 Streamable HTTP 传输。MCP 暴露同名的五种工具，
并调用与 HTTP 相同的内部处理逻辑、认证映射和路径限制。HTTP 与 MCP 使用相同的
产品密钥。

## 6. 工具输入与输出

所有路径均遵循第 4 节规则。成功响应为 JSON；`read` 返回 UTF-8 文本，若读取字节范围不是有效 UTF-8，则返回 Base64 字节。`grep` 跳过非 UTF-8 或包含 NUL 的二进制文件，并报告跳过数量。

### `readdir`

输入：`{ "path": "docs" }`

列出该目录的直接子项，返回每项的名称和类型，并按名称稳定排序。单目录超过返回上限时返回上限内条目，并设置 `truncated: true`。

### `stat`

输入：`{ "path": "docs/brief.pdf" }`

返回 POSIX `stat` 常用字段，包括类型、设备号、特殊设备号、inode、mode、链接数、属主、大小和纳秒时间戳。空路径返回产品根目录元数据；符号链接仍会被拒绝，以维持产品目录边界。

### `read`

输入：`{ "path": "docs/brief.txt", "offset": 0, "length": 4096 }`

按字节偏移读取指定范围，并返回实际读取长度。`length` 不得超过部署配置中的单次读取上限。目标为目录时返回类型错误。若范围内容是有效 UTF-8，响应包含 `content` 和 `encoding: "utf-8"`；否则响应包含可还原原始字节的 `content_base64` 和 `encoding: "base64"`。

### `find`

输入：`{ "path": "", "name_pattern": "*.pdf", "type": "file" }`

在指定目录树内按 basename 模式和类型查找，返回相对于产品根目录的路径列表。`type`
支持 `file`、`directory`、`symlink`、`other` 和 `any`。符号链接作为条目返回，不会跟随。达到部署结果上限时返回部分结果并设置 `truncated: true`；扫描量达到硬上限时返回超限错误。

### `grep`

输入：

```json
{
  "path": "docs",
  "pattern": "launch|date",
  "recursive": true,
  "glob": "*.md",
  "case_sensitive": true,
  "max_results": 100
}
```

`path` 可以指定单个文件或目录；指定文件时仅搜索该文件，指定目录时按 `recursive` 搜索目录树。文件需符合 `glob`。按扩展正则表达式匹配，返回匹配文件的相对路径、行号和整行文本。默认递归扫描并区分大小写；空模式匹配每一行。非 UTF-8 或含 NUL 的文件会跳过，`skipped_non_text_files` 报告跳过数量。超过 `max_results` 时返回前 N 条并标记 `truncated: true`；扫描文件数或读取字节数超过服务硬上限时返回明确错误。

Gateway 容器日志记录 HTTP 请求方法、路径、查询字符串、请求头、完整请求正文、认证后的产品 ID、响应状态和耗时。`Authorization` 值经过脱敏。服务使用 Docker 默认的 `json-file` 日志驱动，不设置容器级日志轮转。

MCP 工具的同步文件操作通过 AnyIO worker thread pool 执行，使并发 MCP 请求可以重叠运行，并受线程限制器约束。HTTP 工具路由由 FastAPI 在线程池中执行。

## 7. 限制与错误

服务必须配置单次读取最大字节数、单目录返回项数、`find` 和 `grep` 的结果数量、
扫描文件数和扫描字节数上限。具体数值属于部署配置，部署时必须提供有效正数；
不得以无限制值运行。

标准错误响应：

```json
{
  "error": {
    "code": "PATH_NOT_FOUND",
    "message": "Requested path does not exist"
  }
}
```

| HTTP 状态 | 使用场景 |
| --- | --- |
| `400` | 参数缺失、类型错误或格式错误 |
| `401` | Bearer 密钥缺失或无效，或产品已停用 |
| `403` | 路径越出产品根目录 |
| `404` | 请求路径不存在 |
| `413` | 单次读取、调用方结果上限配置错误，或服务端搜索文件数、读取字节数、目录扫描硬上限被超过 |
| `500` | NAS I/O 或服务内部错误 |

错误响应包含稳定的机器可读 `code` 和面向调用方的 `message`。服务不得在错误
响应中泄露密钥、主机文件系统的绝对路径或其他产品配置。

## 8. 安全与服务边界

- 只提供目录枚举、元数据读取、文件读取和内容搜索。
- 不提供创建、修改、删除、上传、重命名或权限变更接口。
- 每个请求先验证产品密钥及 `enabled` 状态，再解析产品根目录和请求路径。
- 所有 HTTP 与 MCP 调用共用认证、限制、错误映射和文件访问逻辑。
- 不向调用方返回 NAS 主机路径、其他产品标识或其他产品文件信息。
- NAS 不可用时返回明确的服务错误，不得返回缓存、模拟或其他产品的数据。

## 9. 配置与实现验收条件

部署配置必须提供 SQLite 持久卷、NAS 挂载、HTTP/MCP 监听设置，以及读取和搜索
限制。服务实现完成后，验收至少确认：

1. 每个产品密钥只能访问各自配置的根目录。
2. 无效密钥、停用产品、绝对路径、`..` 和逃逸符号链接均被拒绝。
3. 五种工具经 HTTP 与 MCP 调用时共用相同访问规则。
4. 空路径对 `readdir`、`stat`、`find`、`grep` 均表示产品根目录。
5. `read` 对任意字节范围返回原始字节内容；有效 UTF-8 使用文本返回，其他范围使用 Base64 返回。列表或搜索结果达到调用方上限时返回部分结果并标记 `truncated`，扫描量达到服务硬上限时返回明确错误。
6. 重建 Gateway 容器后，SQLite 中的产品配置仍然存在。

`grep.pattern` 使用扩展正则表达式，默认区分大小写并递归扫描；每个文件按 LF 分行。
非 UTF-8 或含 NUL 的文件会跳过，并计入 `skipped_non_text_files`。超过调用方
`max_results` 时返回前 N 条并设置 `truncated: true`。超过服务扫描文件数或字节数限制时，
返回明确的超限错误。`find.type` 支持 `file`、`directory`、`symlink`、`other` 和 `any`；glob 匹配 basename。

## 10. 当前部署

- Gateway 作为独立 Compose 项目 `nas-gateway` 部署在挂载 NAS 的
  `contentagentsg` 主机。
- Gateway 容器以 UID/GID `10001:10001` 运行，根文件系统只读，NAS bind mount
  只读；SQLite 使用持久化 Docker volume `nas_gateway_data`。
- 现有 Content Agent Nginx 通过独立 Compose override 将 `/nas-gateway/` 转发
  给 Gateway。对外 HTTP 工具路径为
  `http://43.98.204.233/nas-gateway/v1/tools/{tool}`，MCP endpoint 为
  `http://43.98.204.233/nas-gateway/mcp`。
- 已建立 `hatch`、`dify` 和 `802f2105-e28e-4ddc-996a-0a97a7fa4bb5` 三项产品配置，分别映射到各自的 `nas-gateway/products/<product_id>` 根目录。
- 新 product 根目录含 `facts` 与 `reasoning` 两个子目录；NFS 的 NAS Gateway 树内不保留 `.DS_Store` 文件。
- NFS 挂载项已存在于主机 `/etc/fstab`，容器通过 host mount 读取共享目录。
- 容器 health check、五种 HTTP 工具和 MCP 工具发现均已通过真实部署检查；新 product 的目录枚举及文本读取也已通过线上调用验证。
