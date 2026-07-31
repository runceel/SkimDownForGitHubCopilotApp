#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(extensionRoot, "vendor-lock.json");
const sbomPath = path.join(extensionRoot, "vendor-sbom.cdx.json");
const vendorRoot = path.join(extensionRoot, "web", "vendor");
const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;

// The Copilot app extension installer rejects any single file above this size,
// so oversized upstream assets are stored as chunks and reassembled when served.
const MAX_ASSET_BYTES = 1_000_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function chunkPath(logicalPath, index) {
  return `${logicalPath}.${String(index).padStart(3, "0")}`;
}

/** On-disk paths for one manifest entry: the file itself, or its ordered chunks. */
function storedPaths(file) {
  if (!file.chunks) {
    return [file.path];
  }
  return file.chunks.sha256.map((_, index) => chunkPath(file.path, index));
}

function splitBytes(bytes, chunkBytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length)));
  }
  return chunks.length > 0 ? chunks : [bytes.subarray(0, 0)];
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (!commitPattern.test(manifest.upstream?.revision ?? "")) {
    errors.push("upstream.revision must be a lowercase 40-character commit SHA");
  }
  if (!manifest.upstream?.downloadBase?.includes("{revision}")) {
    errors.push("upstream.downloadBase must contain {revision}");
  }

  const components = manifest.components ?? {};
  const seenPaths = new Set();
  const seenStoredPaths = new Set();
  for (const file of manifest.files ?? []) {
    const normalized = path.posix.normalize(file.path ?? "");
    if (
      !file.path ||
      normalized !== file.path ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      normalized.includes("\\")
    ) {
      errors.push(`unsafe asset path: ${file.path ?? "<missing>"}`);
    }
    if (seenPaths.has(file.path)) {
      errors.push(`duplicate asset path: ${file.path}`);
    }
    seenPaths.add(file.path);
    if (!components[file.component]) {
      errors.push(`unknown component "${file.component}" for ${file.path}`);
    }
    if (!sha256Pattern.test(file.sha256 ?? "")) {
      errors.push(`invalid SHA-256 for ${file.path}`);
    }
    if (file.source) {
      try {
        if (new URL(file.source).protocol !== "https:") {
          errors.push(`source must use HTTPS for ${file.path}`);
        }
      } catch {
        errors.push(`invalid source URL for ${file.path}`);
      }
    }

    const chunks = file.chunks;
    if (chunks !== undefined) {
      if (!chunks || typeof chunks !== "object" || Array.isArray(chunks)) {
        errors.push(`chunks must be an object for ${file.path}`);
        continue;
      }
      if (!Number.isInteger(chunks.bytes) || chunks.bytes <= 0 || chunks.bytes > MAX_ASSET_BYTES) {
        errors.push(
          `chunks.bytes must be an integer between 1 and ${MAX_ASSET_BYTES} for ${file.path}`,
        );
      }
      if (
        !Array.isArray(chunks.sha256) ||
        chunks.sha256.length === 0 ||
        !chunks.sha256.every((hash) => sha256Pattern.test(hash ?? ""))
      ) {
        errors.push(`chunks.sha256 must be a non-empty list of SHA-256 hashes for ${file.path}`);
        continue;
      }
    }

    for (const storedPath of storedPaths(file)) {
      if (seenStoredPaths.has(storedPath)) {
        errors.push(`duplicate stored path: ${storedPath}`);
      }
      seenStoredPaths.add(storedPath);
    }
  }
  if (seenPaths.size === 0) {
    errors.push("files must not be empty");
  }

  for (const [name, component] of Object.entries(components)) {
    for (const property of ["version", "license", "homepage", "purl", "officialSource"]) {
      if (!component[property]) {
        errors.push(`component "${name}" is missing ${property}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid vendor-lock.json:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

async function listFiles(directory, relativeDirectory = "") {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" && relativeDirectory === "") {
      throw new Error(
        `Vendor directory not found: ${directory}. Run vendor-assets.mjs restore to recreate it.`,
      );
    }
    throw error;
  }
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in the vendor directory: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported vendor directory entry: ${relativePath}`);
    }
  }
  return files.sort();
}

function expectedPaths(manifest) {
  return manifest.files.flatMap((file) => storedPaths(file)).sort();
}

async function readVendorFile(relativePath, errors) {
  const absolutePath = path.join(vendorRoot, ...relativePath.split("/"));
  try {
    const stat = await lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      errors.push(`not a regular file: ${relativePath}`);
      return null;
    }
    return await readFile(absolutePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      errors.push(`${relativePath}: ${error.message}`);
    }
    return null;
  }
}

async function verifyChunkedFile(file, errors) {
  const paths = storedPaths(file);
  const assembled = createHash("sha256");
  let complete = true;

  for (const [index, relativePath] of paths.entries()) {
    const bytes = await readVendorFile(relativePath, errors);
    if (bytes === null) {
      complete = false;
      continue;
    }
    const actualHash = sha256(bytes);
    if (actualHash !== file.chunks.sha256[index]) {
      errors.push(`${relativePath}: expected ${file.chunks.sha256[index]}, got ${actualHash}`);
      complete = false;
    }
    const isLast = index === paths.length - 1;
    const validLength = isLast
      ? bytes.length > 0 && bytes.length <= file.chunks.bytes
      : bytes.length === file.chunks.bytes;
    if (!validLength) {
      errors.push(
        `${relativePath}: unexpected chunk size ${bytes.length} for chunk size ${file.chunks.bytes}`,
      );
      complete = false;
    }
    assembled.update(bytes);
  }

  if (!complete) {
    return;
  }
  const assembledHash = assembled.digest("hex");
  if (assembledHash !== file.sha256) {
    errors.push(`${file.path}: assembled chunks expected ${file.sha256}, got ${assembledHash}`);
  }
}

async function verifyLocal(manifest) {
  const errors = [];
  const actualPaths = await listFiles(vendorRoot);
  const lockedPaths = expectedPaths(manifest);

  for (const missing of lockedPaths.filter((file) => !actualPaths.includes(file))) {
    errors.push(`missing file: ${missing}`);
  }
  for (const extra of actualPaths.filter((file) => !lockedPaths.includes(file))) {
    errors.push(`unlisted file: ${extra}`);
  }

  for (const relativePath of actualPaths) {
    const stat = await lstat(path.join(vendorRoot, ...relativePath.split("/")));
    if (stat.size > MAX_ASSET_BYTES) {
      errors.push(
        `${relativePath}: ${stat.size} bytes exceeds the ${MAX_ASSET_BYTES} byte installer limit; store the asset as chunks`,
      );
    }
  }

  for (const file of manifest.files) {
    if (file.chunks) {
      await verifyChunkedFile(file, errors);
      continue;
    }
    const bytes = await readVendorFile(file.path, errors);
    if (bytes === null) {
      continue;
    }
    const actualHash = sha256(bytes);
    if (actualHash !== file.sha256) {
      errors.push(`${file.path}: expected ${file.sha256}, got ${actualHash}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Vendored asset verification failed:\n${errors.sort().map((error) => `- ${error}`).join("\n")}`);
  }
  console.log(`Verified ${manifest.files.length} local vendored assets.`);
}

function sourceUrl(manifest, file) {
  if (file.source) {
    return file.source;
  }
  const base = manifest.upstream.downloadBase.replace(
    "{revision}",
    manifest.upstream.revision,
  );
  return new URL(file.path.split("/").map(encodeURIComponent).join("/"), base).href;
}

async function downloadAssets(manifest, verifyExpectedHashes) {
  const downloads = new Map();
  const errors = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < manifest.files.length) {
      const file = manifest.files[nextIndex++];
      const url = sourceUrl(manifest, file);
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "SkimDown-vendor-verifier" },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const actualHash = sha256(bytes);
        if (verifyExpectedHashes && actualHash !== file.sha256) {
          throw new Error(`expected ${file.sha256}, got ${actualHash}`);
        }
        downloads.set(file.path, { bytes, sha256: actualHash });
      } catch (error) {
        errors.push(`${file.path}: ${error.message} (${url})`);
      }
    }
  }

  const workerCount = Math.min(6, manifest.files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (errors.length > 0) {
    throw new Error(`Upstream asset verification failed:\n${errors.sort().map((error) => `- ${error}`).join("\n")}`);
  }
  return downloads;
}

async function verifySource(manifest) {
  await downloadAssets(manifest, true);
  console.log(
    `Verified ${manifest.files.length} assets against ${manifest.upstream.repository}@${manifest.upstream.revision}.`,
  );
}

/** Maps downloaded upstream bytes onto the files that are stored in the repository. */
function storedBytes(manifest, downloads) {
  const stored = new Map();
  for (const file of manifest.files) {
    const download = downloads.get(file.path);
    if (!download) {
      continue;
    }
    if (!file.chunks) {
      stored.set(file.path, download.bytes);
      continue;
    }
    for (const [index, chunk] of splitBytes(download.bytes, file.chunks.bytes).entries()) {
      stored.set(chunkPath(file.path, index), chunk);
    }
  }
  return stored;
}

/** Removes chunks left behind when an asset stops being chunked or shrinks. */
async function removeStaleChunks(manifest, stored) {
  for (const file of manifest.files) {
    const directory = path.join(vendorRoot, ...path.posix.dirname(file.path).split("/"));
    const basename = path.posix.basename(file.path);
    const stalePattern = new RegExp(`^${basename.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{3}$`);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !stalePattern.test(entry.name)) {
        continue;
      }
      const relativePath = path.posix.join(path.posix.dirname(file.path), entry.name);
      if (!stored.has(relativePath)) {
        await rm(path.join(directory, entry.name));
      }
    }
    if (file.chunks && !stored.has(file.path)) {
      await rm(path.join(vendorRoot, ...file.path.split("/")), { force: true });
    }
  }
}

async function stageAssets(manifest, downloads) {
  const stored = storedBytes(manifest, downloads);
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "skimdown-vendor-"));
  try {
    for (const [relativePath, bytes] of stored) {
      const stagedPath = path.join(stagingRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, bytes);
    }
    for (const relativePath of [...stored.keys()].sort()) {
      const destination = path.join(vendorRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      const temporaryDestination = `${destination}.${process.pid}.tmp`;
      await writeFile(
        temporaryDestination,
        await readFile(path.join(stagingRoot, ...relativePath.split("/"))),
      );
      await rename(temporaryDestination, destination);
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  await removeStaleChunks(manifest, stored);
}

function createSbom(manifest) {
  const filesByComponent = new Map();
  for (const file of manifest.files) {
    const files = filesByComponent.get(file.component) ?? [];
    files.push(file.path);
    filesByComponent.set(file.component, files);
  }

  const components = Object.entries(manifest.components)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, component]) => ({
      type: "library",
      "bom-ref": component.purl,
      name,
      version: component.version,
      purl: component.purl,
      licenses: [{ expression: component.license }],
      externalReferences: [
        { type: "website", url: component.homepage },
        { type: "distribution", url: component.officialSource },
      ],
      properties: [
        {
          name: "skimdown:vendored-files",
          value: filesByComponent.get(name).sort().join(","),
        },
      ],
    }));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": "pkg:github/runceel/SkimDownForGitHubCopilotApp",
        name: "SkimDown for GitHub Copilot App",
      },
      properties: [
        { name: "skimdown:upstream-repository", value: manifest.upstream.repository },
        { name: "skimdown:upstream-revision", value: manifest.upstream.revision },
      ],
    },
    components,
    dependencies: [
      {
        ref: "pkg:github/runceel/SkimDownForGitHubCopilotApp",
        dependsOn: components.map((component) => component["bom-ref"]).sort(),
      },
    ],
  };
}

async function writeAtomically(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, filePath);
}

async function verifySbom(manifest) {
  const expected = jsonText(createSbom(manifest));
  const actual = await readFile(sbomPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  if (actual !== expected) {
    throw new Error(
      "vendor-sbom.cdx.json is stale. Run: node .github/extensions/skimdown/scripts/vendor-assets.mjs sbom",
    );
  }
  console.log("Verified CycloneDX SBOM.");
}

async function writeSbom(manifest) {
  await writeAtomically(sbomPath, jsonText(createSbom(manifest)));
  console.log("Updated vendor-sbom.cdx.json.");
}

function assertNoArguments(argumentsList) {
  if (argumentsList.length > 0) {
    throw new Error(`Unexpected arguments: ${argumentsList.join(" ")}`);
  }
}

async function main() {
  const [command = "verify", ...argumentsList] = process.argv.slice(2);
  const manifest = await readManifest();

  if (command === "verify") {
    const checkSource = argumentsList.includes("--source");
    const unknownArguments = argumentsList.filter((argument) => argument !== "--source");
    assertNoArguments(unknownArguments);
    await verifyLocal(manifest);
    await verifySbom(manifest);
    if (checkSource) {
      await verifySource(manifest);
    }
    return;
  }

  if (command === "restore") {
    assertNoArguments(argumentsList);
    const downloads = await downloadAssets(manifest, true);
    await stageAssets(manifest, downloads);
    await verifyLocal(manifest);
    await verifySbom(manifest);
    return;
  }

  if (command === "refresh") {
    if (argumentsList.length !== 1 || !commitPattern.test(argumentsList[0])) {
      throw new Error("Usage: vendor-assets.mjs refresh <lowercase-40-character-commit-sha>");
    }
    const nextManifest = structuredClone(manifest);
    nextManifest.upstream.revision = argumentsList[0];
    const downloads = await downloadAssets(nextManifest, false);
    for (const file of nextManifest.files) {
      const download = downloads.get(file.path);
      file.sha256 = download.sha256;
      if (file.chunks) {
        file.chunks.sha256 = splitBytes(download.bytes, file.chunks.bytes).map(sha256);
      }
    }
    await stageAssets(nextManifest, downloads);
    await writeAtomically(manifestPath, jsonText(nextManifest));
    await verifyLocal(nextManifest);
    console.log(
      "Component metadata and SBOM still require review. Update vendor-lock.json, then run vendor-assets.mjs sbom.",
    );
    return;
  }

  if (command === "sbom") {
    if (argumentsList.length === 1 && argumentsList[0] === "--check") {
      await verifySbom(manifest);
      return;
    }
    assertNoArguments(argumentsList);
    await writeSbom(manifest);
    return;
  }

  throw new Error("Usage: vendor-assets.mjs <verify [--source] | restore | refresh <commit-sha> | sbom [--check]>");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
