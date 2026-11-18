# hatch-agent-box

Sandbox image for BoxLite Cloud boxes (linux/amd64): `docker.io/keithchen/hatch-agent-box` (public, no secrets).

Contents: non-root `agent` (uid 1000, passwordless sudo, so the agent can `sudo apt-get install` / `pip install --user` / `npm i -g`),
curl wget openssl dig whois git jq rg zip/unzip xz build-essential pandoc poppler-utils qpdf imagemagick, Noto CJK + emoji fonts,
Python 3 + pip + uv + httpx requests beautifulsoup4 lxml extruct numpy pandas jinja2 pillow playwright,
Playwright Chromium in `/ms-playwright`, Node 22 + npm, global `lighthouse` (`CHROME_PATH=/usr/local/bin/chrome`).

Build and push (tags: date + latest):

    docker buildx build --platform linux/amd64 -t docker.io/keithchen/hatch-agent-box:YYYY-MM-DD -t docker.io/keithchen/hatch-agent-box:latest --push infra/boxlite-agent

Verify in a real BoxLite box (tools check + per-(product, user) box persistence; removes every box it creates):

    BOXLITE_REST_URL=https://api.boxlite.ai agentsecrets exec --profile hatch --provider boxlite -- \
      python infra/boxlite-agent/verify.py [--image IMAGE] [--out DIR] [--only tools|persist]
