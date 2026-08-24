const buildEnv = import.meta.env ?? {};

export const DESKTOP_DOWNLOAD_BASE_URL = normalizeDownloadBaseUrl(
  buildEnv.VITE_HATCH_DESKTOP_DOWNLOAD_BASE_URL
);

export const DESKTOP_DOWNLOAD_TARGETS = Object.freeze({
  "macos-apple-silicon": Object.freeze({
    key: "macos-apple-silicon",
    platform: "macos",
    labelKey: "download.appleSilicon",
    latestPath: "mac/apple-silicon.dmg",
    primaryLabelKey: "download.preview"
  }),
  "macos-intel": Object.freeze({
    key: "macos-intel",
    platform: "macos",
    labelKey: "download.intel",
    latestPath: "mac/intel.dmg",
    primaryLabelKey: "download.preview"
  })
});

export const DESKTOP_DOWNLOAD_TARGET_ORDER = Object.freeze([
  "macos-apple-silicon",
  "macos-intel"
]);

export function normalizeDownloadBaseUrl(value) {
  const baseUrl = String(value ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return "";
  if (/^https:\/\//i.test(baseUrl) || baseUrl.startsWith("/")) return baseUrl;
  return "";
}

export function desktopDownloadUrl(targetKey, baseUrl = DESKTOP_DOWNLOAD_BASE_URL) {
  const target = DESKTOP_DOWNLOAD_TARGETS[targetKey];
  const normalizedBaseUrl = normalizeDownloadBaseUrl(baseUrl);
  if (!target || !normalizedBaseUrl) return "";
  return `${normalizedBaseUrl}/${target.latestPath}`;
}

export function detectDownloadTarget(navigatorLike = globalThis.navigator) {
  const navigatorValue = navigatorLike ?? {};
  const userAgentData = navigatorValue.userAgentData ?? {};
  const platform = String(userAgentData.platform ?? navigatorValue.platform ?? navigatorValue.userAgent ?? "").toLowerCase();
  const architecture = normalizeArchitecture(userAgentData.architecture);

  if (platform.includes("win")) return "unsupported";
  if (platform.includes("mac") || platform.includes("darwin")) {
    if (architecture === "arm" || architecture === "arm64" || architecture === "aarch64") {
      return "macos-apple-silicon";
    }
    if (architecture === "x86" || architecture === "x86_64" || architecture === "amd64") {
      return "macos-intel";
    }
    return "unknown";
  }
  return "unknown";
}

export async function detectDownloadTargetAsync(navigatorLike = globalThis.navigator) {
  const navigatorValue = navigatorLike ?? {};
  const immediate = detectDownloadTarget(navigatorValue);
  if (immediate !== "unknown") return immediate;
  const userAgentData = navigatorValue.userAgentData;
  if (!userAgentData || typeof userAgentData.getHighEntropyValues !== "function") return immediate;
  try {
    const highEntropy = await userAgentData.getHighEntropyValues(["architecture"]);
    return detectDownloadTarget({
      ...navigatorValue,
      userAgentData: { ...userAgentData, ...highEntropy }
    });
  } catch {
    return immediate;
  }
}

function normalizeArchitecture(value) {
  return String(value ?? "").trim().toLowerCase();
}
