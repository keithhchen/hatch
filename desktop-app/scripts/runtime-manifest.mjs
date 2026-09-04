export const DESKTOP_RUNTIME_VERSION = "2026.09.04.2";
export const NODE_VERSION = "22.23.2";
export const PYTHON_VERSION = "3.12.14";
export const PYTHON_BUILD_TAG = "20260901";
export const LIBREOFFICE_VERSION = "26.2.5";
export const POPPLER_VERSION = "26.05.0";
export const MICROMAMBA_VERSION = "2.8.1-0";

const NODE_BASE_URL = `https://nodejs.org/download/release/v${NODE_VERSION}`;
const PYTHON_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_TAG}`;
const LIBREOFFICE_BASE_URL = `https://download.documentfoundation.org/libreoffice/stable/${LIBREOFFICE_VERSION}`;
const MICROMAMBA_BASE_URL = `https://github.com/mamba-org/micromamba-releases/releases/download/${MICROMAMBA_VERSION}`;
const POPPLER_CHANNEL = "https://conda.anaconda.org/conda-forge";

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
    },
    native: {
      libreoffice: {
        format: "dmg",
        archive: `LibreOffice_${LIBREOFFICE_VERSION}_MacOS_aarch64.dmg`,
        url: `${LIBREOFFICE_BASE_URL}/mac/aarch64/LibreOffice_${LIBREOFFICE_VERSION}_MacOS_aarch64.dmg`,
        sha256: "c99fb4fe574437fc4cb820a4ca15271bca325920861f7139858b36d7f9df78ad",
        license: "MPL-2.0"
      },
      poppler: {
        channel: POPPLER_CHANNEL,
        platform: "osx-arm64",
        packageSpec: `poppler=${POPPLER_VERSION}=hd83632c_3`,
        license: "GPL-2.0-or-later"
      },
      micromamba: {
        archive: "micromamba-osx-arm64",
        url: `${MICROMAMBA_BASE_URL}/micromamba-osx-arm64`,
        sha256: "de71a646b73af92dd663e6ddc78993a6a4d47ea28b5d8908c3cc2b9c3077e528"
      }
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
    },
    native: {
      libreoffice: {
        format: "dmg",
        archive: `LibreOffice_${LIBREOFFICE_VERSION}_MacOS_x86-64.dmg`,
        url: `${LIBREOFFICE_BASE_URL}/mac/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_MacOS_x86-64.dmg`,
        sha256: "e26180298685274b54aa7fe6e1101c65465a372f457a6748ebd642720811db36",
        license: "MPL-2.0"
      },
      poppler: {
        channel: POPPLER_CHANNEL,
        platform: "osx-64",
        packageSpec: `poppler=${POPPLER_VERSION}=h107cf23_3`,
        license: "GPL-2.0-or-later"
      },
      micromamba: {
        archive: "micromamba-osx-64",
        url: `${MICROMAMBA_BASE_URL}/micromamba-osx-64`,
        sha256: "b2bd613791c0a524883d7cb66505d630bf15badd1f492bc93ba78550a3a1a94b"
      }
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
    },
    native: {
      libreoffice: {
        format: "msi",
        archive: `LibreOffice_${LIBREOFFICE_VERSION}_Win_x86-64.msi`,
        url: `${LIBREOFFICE_BASE_URL}/win/x86_64/LibreOffice_${LIBREOFFICE_VERSION}_Win_x86-64.msi`,
        sha256: "f15ba07bfcb0186986cf3171063506f5d207c11f8cc051ba0d135209e9e915f9",
        license: "MPL-2.0"
      },
      poppler: {
        channel: POPPLER_CHANNEL,
        platform: "win-64",
        packageSpec: `poppler=${POPPLER_VERSION}=h4b9d284_3`,
        license: "GPL-2.0-or-later"
      },
      micromamba: {
        archive: "micromamba-win-64.exe",
        url: `${MICROMAMBA_BASE_URL}/micromamba-win-64.exe`,
        sha256: "8a51f88ec02600488ea20c3acd93fbd4da6c0f03fc499aa53fd234c6749b94b0"
      }
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
    },
    native: {
      libreoffice: {
        format: "msi",
        archive: `LibreOffice_${LIBREOFFICE_VERSION}_Win_aarch64.msi`,
        url: `${LIBREOFFICE_BASE_URL}/win/aarch64/LibreOffice_${LIBREOFFICE_VERSION}_Win_aarch64.msi`,
        sha256: "48e99bba813c65a823b86a9fe8c0746a415f3d0e9459255f81f745f58fd353aa",
        license: "MPL-2.0"
      },
      poppler: {
        channel: POPPLER_CHANNEL,
        // conda-forge publishes Poppler for win-64. Windows 11 on ARM64
        // runs this isolated helper through its supported x64 emulation.
        platform: "win-64",
        packageSpec: `poppler=${POPPLER_VERSION}=h4b9d284_3`,
        license: "GPL-2.0-or-later",
        executionArch: "x64"
      },
      micromamba: {
        archive: "micromamba-win-arm64.exe",
        url: `${MICROMAMBA_BASE_URL}/micromamba-win-arm64.exe`,
        sha256: "c90eda5e4c88ebd4fb4c857d7c98d7484156fae5419b72c9c652f331ad7aad9f"
      }
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

export function currentBuildTarget(environment = process.env) {
  const platform = normalizePlatform(environment.TAURI_ENV_PLATFORM?.trim() || process.platform);
  const arch = normalizeArch(environment.TAURI_ENV_ARCH?.trim() || process.arch);
  return currentTarget(platform, arch);
}

export function targetForKey(key) {
  const separator = key.lastIndexOf("-");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`Invalid Hatch Desktop runtime target ${JSON.stringify(key)}.`);
  }
  return currentTarget(key.slice(0, separator), key.slice(separator + 1));
}

export function runtimeTargetMatrix() {
  return Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, structuredClone(target)]));
}

function normalizePlatform(platform) {
  if (["darwin", "macos", "mac"].includes(platform)) return "darwin";
  if (["win32", "windows", "win"].includes(platform)) return "win32";
  return platform;
}

function normalizeArch(arch) {
  if (["x64", "x86_64", "amd64"].includes(arch)) return "x64";
  if (["arm64", "aarch64"].includes(arch)) return "arm64";
  return arch;
}
