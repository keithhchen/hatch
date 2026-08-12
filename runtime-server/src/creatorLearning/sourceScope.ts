import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { FactorySource, FactorySourceManifest } from "./types.js";

type DigestBinding = {
  path: string;
  /** Either spelling is accepted at the JSON boundary; if both are present they must agree. */
  digest?: string;
  sha256?: string;
};

export type CreatorSourceScopeInput = {
  pack_root: string;
  creator_directory: string;
  /** Optional compatibility spelling; exhaustive traversal is always implied. */
  completeness?: "all_regular_files";
  authority?: FactorySource["authority"];
  /** Optional integrity enhancement. Exhaustive snapshotting does not require an inventory. */
  checksums_sha256?: DigestBinding | string;
  /** A digest-bound JSON inventory with `files[]` or `documents[]`. */
  manifest?: DigestBinding;
};

export type ResolvedCreatorSourceScope = {
  sources: FactorySource[];
  sourceManifest: FactorySourceManifest;
};

type FrozenFile = {
  path: string;
  bytes: Buffer;
  content: string;
  sha256: string;
};

type ExpectedFile = {
  path: string;
  sha256: string;
  bytes?: number;
};

type ParsedScope = {
  packRoot: string;
  creatorDirectory: string;
  completeness: "all_regular_files";
  authority: FactorySource["authority"];
  binding?:
    | { kind: "checksums_sha256"; path: string; expectedDigest?: string }
    | { kind: "manifest"; path: string; expectedDigest: string };
};

const AUTHORITIES = new Set<FactorySource["authority"]>([
  "creator_current",
  "creator_example",
  "private_material",
  "public_context"
]);
const SHA256_PATTERN = /^(?:sha256:)?([a-fA-F0-9]{64})$/;
// `ignoreBOM: true` preserves a leading UTF-8 BOM as U+FEFF. That makes the
// decoded/re-encoded source byte-identical to the file whose hash we froze.
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Exhaustively snapshot one authorized Creator directory. There is no file
 * extension, filename, size, or relevance filter: every regular file must be
 * represented by the integrity inventory and is delivered to the Factory LLM.
 */
export async function resolveCreatorSourceScope(
  rawScope: unknown,
  manifestDirectory: string
): Promise<ResolvedCreatorSourceScope> {
  const scope = parseScope(rawScope);
  const packRoot = path.resolve(manifestDirectory, scope.packRoot);
  const packRootStat = await lstat(packRoot).catch((error: unknown) => {
    throw sourceScopeFsError(`pack_root cannot be read: ${scope.packRoot}`, error);
  });
  if (packRootStat.isSymbolicLink()) throw new Error("source_scope pack_root must not be a symbolic link");
  if (!packRootStat.isDirectory()) throw new Error("source_scope pack_root must be a directory");
  const realPackRoot = await realpath(packRoot);

  await assertDirectoryPath(packRoot, realPackRoot, scope.creatorDirectory, "creator_directory");
  const files = await enumerateRegularFiles(packRoot, realPackRoot, scope.creatorDirectory);
  if (files.length === 0) {
    throw new Error("source_scope creator_directory contains no regular files");
  }

  let integrity: FactorySourceManifest["integrity"] = { kind: "directory_snapshot" };
  if (scope.binding) {
    const integrityBytes = await readRegularFileWithinPack(
      packRoot,
      realPackRoot,
      scope.binding.path,
      `${scope.binding.kind} integrity file`
    );
    const integritySha256 = sha256(integrityBytes);
    if (scope.binding.expectedDigest && integritySha256 !== scope.binding.expectedDigest) {
      throw new Error(
        `source_scope ${scope.binding.kind} digest mismatch: expected ${scope.binding.expectedDigest}, got ${integritySha256}`
      );
    }
    const decodedIntegrityText = decodeUtf8(integrityBytes, `${scope.binding.kind} integrity file`);
    // A text-inventory BOM is encoding metadata rather than inventory content.
    // Its bytes remain covered by integritySha256, but parsers consume the text
    // after exactly one leading U+FEFF. Creator source files do not use this path
    // and preserve a BOM byte-for-byte.
    const integrityText = decodedIntegrityText.startsWith("\uFEFF")
      ? decodedIntegrityText.slice(1)
      : decodedIntegrityText;
    const inventory = scope.binding.kind === "checksums_sha256"
      ? parseChecksums(integrityText)
      : parseJsonManifest(integrityText);
    const expected = inventory.filter((entry) => isInsideCreatorDirectory(entry.path, scope.creatorDirectory));
    if (expected.length === 0) {
      throw new Error(`source_scope integrity inventory has no entries beneath ${scope.creatorDirectory}`);
    }
    assertDeliveredSetEquality(files, expected);
    integrity = {
      kind: scope.binding.kind,
      path: scope.binding.path,
      sha256: integritySha256
    };
  }

  const sources: FactorySource[] = [];
  const manifestFiles: FactorySourceManifest["files"] = [];
  const sourceIds = new Set<string>();
  for (const file of files) {
    const sourceId = sourceIdForPath(file.path);
    if (sourceIds.has(sourceId)) {
      throw new Error(`source_scope generated a duplicate source id for ${file.path}`);
    }
    sourceIds.add(sourceId);
    const title = file.path.slice(scope.creatorDirectory.length + 1);
    sources.push({
      id: sourceId,
      authority: scope.authority,
      title,
      content: file.content
    });
    manifestFiles.push({
      source_id: sourceId,
      path: file.path,
      title,
      bytes: file.bytes.byteLength,
      sha256: file.sha256
    });
  }

  const sourceManifest: FactorySourceManifest = {
    contract_version: "1",
    completeness: scope.completeness,
    creator_directory: scope.creatorDirectory,
    authority: scope.authority,
    integrity,
    file_count: manifestFiles.length,
    total_bytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
    root_digest: computeFactorySourceRootDigest(manifestFiles),
    files: manifestFiles
  };
  validateFactorySourceManifest(sourceManifest, sources);
  return { sources, sourceManifest };
}

/**
 * Revalidate the frozen proof at the engine boundary. This prevents a caller
 * from changing, omitting, or reordering a generated source after directory
 * verification but before the packet is persisted and delivered.
 */
export function validateFactorySourceManifest(
  manifest: FactorySourceManifest,
  sources: readonly FactorySource[]
): void {
  requireExactKeys(manifest, [
    "contract_version",
    "completeness",
    "creator_directory",
    "authority",
    "integrity",
    "file_count",
    "total_bytes",
    "root_digest",
    "files"
  ], "Factory source manifest");
  if (manifest.contract_version !== "1" || manifest.completeness !== "all_regular_files") {
    throw new Error("Factory source manifest has an unsupported contract or completeness policy");
  }
  const creatorDirectory = canonicalRelativePath(manifest.creator_directory, "source manifest creator_directory");
  if (!AUTHORITIES.has(manifest.authority)) throw new Error("Factory source manifest has an invalid authority");
  if (manifest.integrity.kind === "directory_snapshot") {
    requireExactKeys(manifest.integrity, ["kind"], "Factory source manifest integrity");
  } else if (manifest.integrity.kind === "checksums_sha256" || manifest.integrity.kind === "manifest") {
    requireExactKeys(manifest.integrity, ["kind", "path", "sha256"], "Factory source manifest integrity");
    canonicalRelativePath(manifest.integrity.path, "source manifest integrity path");
    requireSha256(manifest.integrity.sha256, "source manifest integrity sha256");
  } else {
    throw new Error("Factory source manifest has an invalid integrity kind");
  }
  requireSha256(manifest.root_digest, "source manifest root_digest");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("Factory source manifest must contain every regular file");
  }
  if (manifest.file_count !== manifest.files.length || manifest.file_count !== sources.length) {
    throw new Error("Factory source manifest file_count does not equal the delivered source set");
  }

  const paths = new Set<string>();
  const normalizedPaths = new Set<string>();
  const sourceIds = new Set<string>();
  let totalBytes = 0;
  let previousPath: string | undefined;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index]!;
    requireExactKeys(file, ["source_id", "path", "title", "bytes", "sha256"], `Factory source manifest file ${index}`);
    const filePath = canonicalRelativePath(file.path, `source manifest file ${index} path`);
    if (!isInsideCreatorDirectory(filePath, creatorDirectory)) {
      throw new Error(`Factory source manifest path escapes creator_directory: ${filePath}`);
    }
    if (paths.has(filePath) || normalizedPaths.has(filePath.normalize("NFC"))) {
      throw new Error(`Factory source manifest has a duplicate path: ${filePath}`);
    }
    paths.add(filePath);
    normalizedPaths.add(filePath.normalize("NFC"));
    if (previousPath !== undefined && comparePaths(previousPath, filePath) >= 0) {
      throw new Error("Factory source manifest files must be in canonical path order");
    }
    previousPath = filePath;
    if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(file.source_id) || sourceIds.has(file.source_id)) {
      throw new Error(`Factory source manifest has an invalid or duplicate source_id: ${file.source_id}`);
    }
    sourceIds.add(file.source_id);
    if (typeof file.title !== "string" || !file.title || /[\r\n]/.test(file.title)) {
      throw new Error(`Factory source manifest has an invalid title for ${filePath}`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error(`Factory source manifest has invalid bytes for ${filePath}`);
    }
    requireSha256(file.sha256, `source manifest sha256 for ${filePath}`);
    totalBytes += file.bytes;

    const source = sources[index];
    if (
      !source
      || source.id !== file.source_id
      || source.authority !== manifest.authority
      || source.title !== file.title
    ) {
      throw new Error(`Factory source manifest does not equal the delivered source at ${filePath}`);
    }
    const deliveredBytes = Buffer.from(source.content, "utf8");
    if (deliveredBytes.byteLength !== file.bytes || sha256(deliveredBytes) !== file.sha256) {
      throw new Error(`Factory source content hash/bytes mismatch for ${filePath}`);
    }
  }
  if (manifest.total_bytes !== totalBytes) {
    throw new Error("Factory source manifest total_bytes does not equal the delivered source set");
  }
  const rootDigest = computeFactorySourceRootDigest(manifest.files);
  if (manifest.root_digest !== rootDigest) {
    throw new Error(`Factory source manifest root_digest mismatch: expected ${rootDigest}`);
  }
}

/** Digest only the delivered set: canonical path, exact byte count, and hash. */
export function computeFactorySourceRootDigest(
  files: ReadonlyArray<Pick<FactorySourceManifest["files"][number], "path" | "bytes" | "sha256">>
): string {
  const ordered = [...files].sort((left, right) => comparePaths(left.path, right.path));
  const hash = createHash("sha256");
  hash.update("hatch.creator-source-root.v1\0", "utf8");
  for (const file of ordered) {
    hash.update(file.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(file.bytes), "utf8");
    hash.update("\0", "utf8");
    hash.update(file.sha256, "utf8");
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function parseScope(value: unknown): ParsedScope {
  const scope = requireObject(value, "source_scope");
  requireOnlyKeys(scope, [
    "pack_root",
    "creator_directory",
    "completeness",
    "authority",
    "checksums_sha256",
    "manifest"
  ], "source_scope");
  if (
    typeof scope.pack_root !== "string"
    || !scope.pack_root.trim()
    || !isWellFormedUnicode(scope.pack_root)
  ) {
    throw new Error("source_scope.pack_root must be a non-empty path");
  }
  if (typeof scope.creator_directory !== "string") {
    throw new Error("source_scope.creator_directory must be a path relative to pack_root");
  }
  const creatorDirectory = canonicalRelativePath(scope.creator_directory, "source_scope.creator_directory");
  if (scope.completeness !== undefined && scope.completeness !== "all_regular_files") {
    throw new Error('source_scope.completeness must be "all_regular_files"');
  }
  const authority = scope.authority === undefined ? "public_context" : scope.authority;
  if (typeof authority !== "string" || !AUTHORITIES.has(authority as FactorySource["authority"])) {
    throw new Error("source_scope.authority is invalid");
  }
  const hasChecksums = Object.prototype.hasOwnProperty.call(scope, "checksums_sha256");
  const hasManifest = Object.prototype.hasOwnProperty.call(scope, "manifest");
  if (hasChecksums && hasManifest) {
    throw new Error("source_scope accepts at most one checksums_sha256 or manifest integrity binding");
  }
  const binding = hasChecksums
    ? parseBinding(scope.checksums_sha256, "checksums_sha256", false)
    : hasManifest
      ? parseBinding(scope.manifest, "manifest", true)
      : undefined;
  return {
    packRoot: scope.pack_root,
    creatorDirectory,
    completeness: "all_regular_files",
    authority: authority as FactorySource["authority"],
    ...(binding ? {
      binding: binding.kind === "checksums_sha256"
        ? binding
        : { ...binding, expectedDigest: binding.expectedDigest! }
    } : {})
  };
}

function parseBinding(
  value: unknown,
  kind: "checksums_sha256" | "manifest",
  digestRequired: boolean
): NonNullable<ParsedScope["binding"]> {
  const row = typeof value === "string" ? { path: value } : requireObject(value, `source_scope.${kind}`);
  requireOnlyKeys(row, ["path", "digest", "sha256"], `source_scope.${kind}`);
  if (typeof row.path !== "string") throw new Error(`source_scope.${kind}.path must be a string`);
  const bindingPath = canonicalRelativePath(row.path, `source_scope.${kind}.path`);
  const first = row.digest === undefined ? undefined : normalizeSha256(row.digest, `source_scope.${kind}.digest`);
  const second = row.sha256 === undefined ? undefined : normalizeSha256(row.sha256, `source_scope.${kind}.sha256`);
  if (first && second && first !== second) {
    throw new Error(`source_scope.${kind} digest and sha256 disagree`);
  }
  const expectedDigest = first ?? second;
  if (digestRequired && !expectedDigest) throw new Error(`source_scope.${kind}.digest is required`);
  return kind === "checksums_sha256"
    ? { kind, path: bindingPath, ...(expectedDigest ? { expectedDigest } : {}) }
    : { kind, path: bindingPath, expectedDigest: expectedDigest! };
}

async function enumerateRegularFiles(
  packRoot: string,
  realPackRoot: string,
  creatorDirectory: string
): Promise<FrozenFile[]> {
  const result: FrozenFile[] = [];
  const normalizedPaths = new Set<string>();

  const visit = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = pathWithin(packRoot, relativeDirectory);
    const rawEntries = await readdir(absoluteDirectory, { withFileTypes: true, encoding: "buffer" });
    const entries = rawEntries.map((entry) => ({
      entry,
      name: decodeUtf8(entry.name, `filename beneath ${relativeDirectory}`)
    })).sort((left, right) => comparePaths(left.name, right.name));

    for (const { entry, name } of entries) {
      if (!name || /[\u0000-\u001f\u007f]/.test(name) || name.includes("/") || name.includes("\\")) {
        throw new Error(`source_scope contains an unsafe filename beneath ${relativeDirectory}`);
      }
      const relativePath = `${relativeDirectory}/${name}`;
      const absolutePath = pathWithin(packRoot, relativePath);
      const stat = await lstat(absolutePath);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`source_scope rejects symbolic link: ${relativePath}`);
      }
      const resolved = await realpath(absolutePath);
      assertRealContainment(realPackRoot, resolved, relativePath);
      if (stat.isDirectory()) {
        await visit(relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`source_scope rejects non-regular file: ${relativePath}`);
      }
      const normalized = relativePath.normalize("NFC");
      if (normalizedPaths.has(normalized)) {
        throw new Error(`source_scope discovered a duplicate normalized path: ${relativePath}`);
      }
      normalizedPaths.add(normalized);
      const bytes = await readOpenedRegularFile(absolutePath, realPackRoot, relativePath);
      result.push({
        path: relativePath,
        bytes,
        content: decodeUtf8(bytes, relativePath),
        sha256: sha256(bytes)
      });
    }
  };

  await visit(creatorDirectory);
  return result.sort((left, right) => comparePaths(left.path, right.path));
}

async function assertDirectoryPath(
  packRoot: string,
  realPackRoot: string,
  relativeDirectory: string,
  label: string
): Promise<void> {
  let current = "";
  for (const segment of relativeDirectory.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    const absolute = pathWithin(packRoot, current);
    const stat = await lstat(absolute).catch((error: unknown) => {
      throw sourceScopeFsError(`source_scope ${label} cannot be read: ${relativeDirectory}`, error);
    });
    if (stat.isSymbolicLink()) throw new Error(`source_scope rejects symbolic link in ${label}: ${current}`);
    if (!stat.isDirectory()) throw new Error(`source_scope ${label} is not a directory: ${relativeDirectory}`);
    assertRealContainment(realPackRoot, await realpath(absolute), current);
  }
}

async function readRegularFileWithinPack(
  packRoot: string,
  realPackRoot: string,
  relativePath: string,
  label: string
): Promise<Buffer> {
  const segments = relativePath.split("/");
  let current = "";
  for (let index = 0; index < segments.length; index += 1) {
    current = current ? `${current}/${segments[index]}` : segments[index]!;
    const absolute = pathWithin(packRoot, current);
    const stat = await lstat(absolute).catch((error: unknown) => {
      throw sourceScopeFsError(`source_scope ${label} cannot be read: ${relativePath}`, error);
    });
    if (stat.isSymbolicLink()) throw new Error(`source_scope rejects symbolic link in ${label}: ${current}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`source_scope ${label} parent is not a directory: ${current}`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`source_scope ${label} is not a regular file: ${relativePath}`);
    }
    assertRealContainment(realPackRoot, await realpath(absolute), current);
  }
  return readOpenedRegularFile(pathWithin(packRoot, relativePath), realPackRoot, relativePath);
}

async function readOpenedRegularFile(
  absolutePath: string,
  realPackRoot: string,
  displayPath: string
): Promise<Buffer> {
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`source_scope rejects non-regular file: ${displayPath}`);
    const pathBefore = await lstat(absolutePath);
    if (
      pathBefore.isSymbolicLink()
      || !pathBefore.isFile()
      || pathBefore.dev !== before.dev
      || pathBefore.ino !== before.ino
    ) {
      throw new Error(`source_scope path changed while it was being frozen: ${displayPath}`);
    }
    assertRealContainment(realPackRoot, await realpath(absolutePath), displayPath);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await lstat(absolutePath);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== after.size
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino
    ) {
      throw new Error(`source_scope file changed while it was being frozen: ${displayPath}`);
    }
    assertRealContainment(realPackRoot, await realpath(absolutePath), displayPath);
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseChecksums(content: string): ExpectedFile[] {
  const rows: ExpectedFile[] = [];
  const paths = new Set<string>();
  const normalizedPaths = new Set<string>();
  for (const [index, rawLine] of content.replaceAll("\r\n", "\n").split("\n").entries()) {
    if (!rawLine || rawLine.startsWith("#")) continue;
    // Coreutils/BSD form is `<hex><space><mode><path>`, where mode is a
    // second space (text) or `*` (binary). Keeping the mode separate means a
    // legitimate text filename beginning with `*` is not silently rewritten.
    const match = /^([a-fA-F0-9]{64}) ([ *])(.+)$/.exec(rawLine);
    if (!match) throw new Error(`source_scope checksums_sha256 has a malformed line ${index + 1}`);
    const filePath = canonicalRelativePath(match[3]!, `checksums_sha256 line ${index + 1} path`);
    assertUniqueInventoryPath(filePath, paths, normalizedPaths, "checksums_sha256");
    rows.push({ path: filePath, sha256: `sha256:${match[1]!.toLowerCase()}` });
  }
  if (rows.length === 0) throw new Error("source_scope checksums_sha256 is empty");
  return rows;
}

function parseJsonManifest(content: string): ExpectedFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("source_scope manifest is not valid JSON");
  }
  const manifest = requireObject(parsed, "source_scope manifest");
  const hasFiles = Object.prototype.hasOwnProperty.call(manifest, "files");
  const hasDocuments = Object.prototype.hasOwnProperty.call(manifest, "documents");
  if (hasFiles === hasDocuments) {
    throw new Error("source_scope manifest requires exactly one files[] or documents[] inventory");
  }
  const inventory = hasFiles ? manifest.files : manifest.documents;
  if (!Array.isArray(inventory)) {
    throw new Error(`source_scope manifest ${hasFiles ? "files" : "documents"} must be an array`);
  }
  const rows: ExpectedFile[] = [];
  const paths = new Set<string>();
  const normalizedPaths = new Set<string>();
  for (let index = 0; index < inventory.length; index += 1) {
    const item = requireObject(inventory[index], `source_scope manifest entry ${index}`);
    if (typeof item.path !== "string") throw new Error(`source_scope manifest entry ${index} needs path`);
    const filePath = canonicalRelativePath(item.path, `source_scope manifest entry ${index} path`);
    assertUniqueInventoryPath(filePath, paths, normalizedPaths, "manifest");
    const digest = normalizeSha256(item.sha256, `source_scope manifest entry ${index} sha256`);
    let bytes: number | undefined;
    if (item.bytes !== undefined) {
      if (!Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) {
        throw new Error(`source_scope manifest entry ${index} has invalid bytes`);
      }
      bytes = Number(item.bytes);
    }
    rows.push({ path: filePath, sha256: digest, ...(bytes === undefined ? {} : { bytes }) });
  }
  if (rows.length === 0) throw new Error("source_scope manifest inventory is empty");
  return rows;
}

function assertDeliveredSetEquality(actual: readonly FrozenFile[], expected: readonly ExpectedFile[]): void {
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  const expectedByPath = new Map(expected.map((file) => [file.path, file]));
  const missing = expected.filter((file) => !actualByPath.has(file.path)).map((file) => file.path);
  const extra = actual.filter((file) => !expectedByPath.has(file.path)).map((file) => file.path);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error([
      "source_scope delivered set does not equal its integrity inventory",
      ...(missing.length > 0 ? [`missing files: ${missing.join(", ")}`] : []),
      ...(extra.length > 0 ? [`extra files: ${extra.join(", ")}`] : [])
    ].join("; "));
  }
  for (const expectedFile of expected) {
    const actualFile = actualByPath.get(expectedFile.path)!;
    if (actualFile.sha256 !== expectedFile.sha256) {
      throw new Error(
        `source_scope hash mismatch for ${expectedFile.path}: expected ${expectedFile.sha256}, got ${actualFile.sha256}`
      );
    }
    if (expectedFile.bytes !== undefined && actualFile.bytes.byteLength !== expectedFile.bytes) {
      throw new Error(
        `source_scope byte-count mismatch for ${expectedFile.path}: expected ${expectedFile.bytes}, got ${actualFile.bytes.byteLength}`
      );
    }
  }
}

function assertUniqueInventoryPath(
  filePath: string,
  paths: Set<string>,
  normalizedPaths: Set<string>,
  label: string
): void {
  const normalized = filePath.normalize("NFC");
  if (paths.has(filePath) || normalizedPaths.has(normalized)) {
    throw new Error(`source_scope ${label} has a duplicate path: ${filePath}`);
  }
  paths.add(filePath);
  normalizedPaths.add(normalized);
}

function sourceIdForPath(filePath: string): string {
  return `source-${createHash("sha256").update(filePath, "utf8").digest("hex")}`;
}

function pathWithin(root: string, relativePath: string): string {
  const destination = path.resolve(root, ...relativePath.split("/"));
  const relation = path.relative(root, destination);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`source_scope path escapes pack_root: ${relativePath}`);
  }
  return destination;
}

function assertRealContainment(realRoot: string, realDestination: string, displayPath: string): void {
  const relation = path.relative(realRoot, realDestination);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`source_scope path escapes pack_root: ${displayPath}`);
  }
}

function canonicalRelativePath(value: string, label: string): string {
  if (
    !value
    || !isWellFormedUnicode(value)
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.split("/").some((segment) => !segment || segment === "." || segment === "..")
    || path.posix.normalize(value) !== value
  ) {
    throw new Error(`${label} must be a canonical relative path and must not escape pack_root: ${value}`);
  }
  return value;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isInsideCreatorDirectory(filePath: string, creatorDirectory: string): boolean {
  return filePath.startsWith(`${creatorDirectory}/`);
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`source_scope ${label} contains invalid UTF-8`);
  }
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizeSha256(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a SHA-256 digest`);
  const match = SHA256_PATTERN.exec(value);
  if (!match) throw new Error(`${label} must be a SHA-256 digest`);
  return `sha256:${match[1]!.toLowerCase()}`;
}

function requireSha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 digest`);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${label} contains unsupported field: ${extra[0]}`);
}

function requireExactKeys(value: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const missing = expected.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !expected.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} fields are invalid; missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}`);
  }
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sourceScopeFsError(message: string, error: unknown): Error {
  const suffix = error && typeof error === "object" && "code" in error ? ` (${String(error.code)})` : "";
  return new Error(`${message}${suffix}`);
}
