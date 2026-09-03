export const DESKTOP_RUNTIME_VERSION = "2026.09.04.1";
export const NODE_VERSION = "22.23.2";
export const PYTHON_VERSION = "3.12.14";
export const PYTHON_BUILD_TAG = "20260901";

const NODE_BASE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}`;
const PYTHON_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_TAG}`;

const targets = {
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    node: {
      archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      url: `${NODE_BASE_URL}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      sha256: "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6"
    },
    python: {
      archive: `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-aarch64-apple-darwin-install_only.tar.gz`,
      url: `${PYTHON_BASE_URL}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD_TAG}-aarch64-apple-darwin-install_only.tar.gz`,
      sha256: "3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76"
    },
    executables: {
      node: "node/bin/node",
      python: "python/bin/python3"
    }
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    node: {
      archive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
      url: `${NODE_BASE_URL}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
      sha256: "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026"
    },
    python: {
      archive: `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
      url: `${PYTHON_BASE_URL}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD_TAG}-x86_64-apple-darwin-install_only.tar.gz`,
      sha256: "2e31b23f3f1319f707d0e620b48847a0046577541d357276821f9f1b5492e0ba"
    },
    executables: {
      node: "node/bin/node",
      python: "python/bin/python3"
    }
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    node: {
      archive: `node-v${NODE_VERSION}-win-x64.zip`,
      url: `${NODE_BASE_URL}/node-v${NODE_VERSION}-win-x64.zip`,
      sha256: "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
    },
    python: {
      archive: `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`,
      url: `${PYTHON_BASE_URL}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`,
      sha256: "e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f"
    },
    executables: {
      node: "node/node.exe",
      python: "python/python.exe"
    }
  },
  "win32-arm64": {
    platform: "win32",
    arch: "arm64",
    node: {
      archive: `node-v${NODE_VERSION}-win-arm64.zip`,
      url: `${NODE_BASE_URL}/node-v${NODE_VERSION}-win-arm64.zip`,
      sha256: "fec025a6da31757e3b6af84c5a1628e9d38442ca99a2161091d78f2fcfa35ef3"
    },
    python: {
      archive: `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-aarch64-pc-windows-msvc-install_only.tar.gz`,
      url: `${PYTHON_BASE_URL}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD_TAG}-aarch64-pc-windows-msvc-install_only.tar.gz`,
      sha256: "4e852236277eb8f7105cbe0f5adf45592f521af238bc0f700c351856e2c2e41a"
    },
    executables: {
      node: "node/node.exe",
      python: "python/python.exe"
    }
  }
};

export function currentTarget(platform = process.platform, arch = process.arch) {
  const target = targets[`${platform}-${arch}`];
  if (!target) {
    throw new Error(`Hatch Desktop runtime does not support ${platform}/${arch}; supported targets: ${Object.keys(targets).join(", ")}`);
  }
  return { key: `${platform}-${arch}`, ...target };
}

export function runtimeTargetMatrix() {
  return Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, structuredClone(target)]));
}
