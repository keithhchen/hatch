FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
      sudo curl wget openssl ca-certificates dnsutils whois \
      git jq ripgrep unzip xz-utils zip build-essential pandoc poppler-utils qpdf imagemagick \
      fonts-noto-cjk fonts-noto-color-emoji \
      python3 python3-pip python3-venv python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Non-root user `agent` (uid 1000) with passwordless sudo.
RUN userdel -r node \
    && useradd -m -u 1000 -s /bin/bash agent \
    && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
    && chmod 0440 /etc/sudoers.d/agent

# System python: allow `pip install --user` for the agent (drop PEP 668 marker).
RUN rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
    && pip install --no-cache-dir uv httpx requests beautifulsoup4 lxml extruct numpy pandas jinja2 pillow playwright \
    && mkdir -p /ms-playwright \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && ln -s "$(find /ms-playwright -type f -name chrome -path '*chromium-*' | head -1)" /usr/local/bin/chrome \
    && rm -rf /var/lib/apt/lists/*

USER agent
ENV HOME=/home/agent \
    NPM_CONFIG_PREFIX=/home/agent/.npm-global \
    CHROME_PATH=/usr/local/bin/chrome
ENV PATH=/home/agent/.local/bin:/home/agent/.npm-global/bin:$PATH
WORKDIR /home/agent
RUN npm install -g lighthouse && npm cache clean --force

CMD ["sleep", "infinity"]
