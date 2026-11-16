# NAS Gateway

Standalone read-only HTTP and Streamable HTTP MCP service for the shared NAS.

## Service contract

- HTTP tools: `POST /v1/tools/{readdir|stat|read|find|grep}`.
- MCP endpoint: `/mcp`, with the same five tool names and Bearer key.
- Health endpoint: unauthenticated `GET /healthz`.
- Request paths are relative to a product's configured NAS root. Absolute paths,
  parent segments, and symlinks are rejected.
- Product keys are generated with `secrets.token_urlsafe(48)` and stored in the
  persistent SQLite volume. The admin command prints the key only when creating
  or rotating it.
- NAS is mounted read-only inside the container. SQLite state uses the separate
  `nas_gateway_data` Docker volume.
- Synchronous filesystem work from MCP tools runs in AnyIO's worker thread pool;
  concurrent MCP requests can overlap, subject to its thread limiter. HTTP tool
  routes use FastAPI's synchronous route thread pool.

## Run with Docker Compose

The deployment host is `hatch-prod` (Aliyun ap-southeast-1, the same VPC as the NAS). The NAS is mounted
read-only at `/mnt/workspaces` from `/etc/fstab`:

```
071wlapx9h87rjkmyi6-dba97.ap-southeast-1.nas.aliyuncs.com:/ /mnt/workspaces nfs ro,vers=3,rsize=1048576,wsize=1048576,hard,nolock,noresvport,proto=tcp,timeo=600,retrans=2,_netdev,nofail 0 0
```

The service joins the app's `hatch_internal` Docker network as `nas-gateway` and is not published to the internet;
Agents reach it at `http://nas-gateway:8000/mcp` (the `tool_connections` row of each product). Deploy from
`/opt/nas-gateway` on the host:

```sh
docker compose -f compose.yml build
docker compose -f compose.yml up -d
docker compose -f compose.yml ps
```

Product keys live in the `hatch_nas_gateway_data` volume (`gateway.sqlite3`).

## Product administration

Create a product-specific NAS directory first, then create its configuration:

```sh
docker compose -f compose.yml exec nas-gateway \
  python -m app.cli add-product \
  --product-id hatch \
  --nas-root nas-gateway/products/hatch
```

The command prints a product ID and its one-time Bearer key. Deliver that key
only to the corresponding product. Repeat with a distinct product ID and
directory for Dify.

The public URL uses the existing Content Agent hostname and the `/nas-gateway`
prefix. For example, HTTP `readdir` is available at
`/nas-gateway/v1/tools/readdir` and MCP at `/nas-gateway/mcp`.

Other commands:

```sh
docker compose -f compose.yml exec nas-gateway python -m app.cli list-products
docker compose -f compose.yml exec nas-gateway python -m app.cli set-enabled --product-id hatch --enabled false
docker compose -f compose.yml exec nas-gateway python -m app.cli rotate-key --product-id hatch
```

`list-products` never prints keys. Disable a product before retiring its access.

## Limits

Compose sets a 4 MiB read limit, 5,000 entries per directory listing, 1,000 results for `find` and `grep`, 20,000 searched directory entries, 10,000 grep files, and 64 MiB of grep input. All limits must remain positive.

`readdir`, `find`, and `grep` return capped results with `truncated: true`. Search file-count, directory-entry, and byte-scan hard limits still return errors.

`grep.path` accepts a single file or a directory; an empty path starts at the product root. `grep.pattern` is required, non-empty, and uses Python `re` syntax. Empty patterns are rejected because they would match every line. Directories are searched recursively by default, subject to `recursive`; `glob` filters basenames. Matching is case-sensitive by default. For an initial broad search, search a relevant directory and set `max_results=50`; this limit counts matching lines. If `truncated=true` and more matches are needed, retry with `max_results=100`. Results include each matching path, 1-based line number, full line, scanned file and byte counts, skipped non-text file count, and truncation state. Non-UTF-8 or NUL-containing files are skipped and counted in `skipped_non_text_files`.

Each HTTP request is written to the Gateway container log with its method, path, query, headers, complete request body, authenticated product ID, response status, and duration. The `Authorization` value is redacted. Read the records with `docker compose logs nas-gateway`; the service uses Docker's default `json-file` logging without container-level rotation settings.
