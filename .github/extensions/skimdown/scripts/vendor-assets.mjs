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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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
  return manifest.files.map((file) => file.path).sort();
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

  for (const file of manifest.files) {
    const absolutePath = path.join(vendorRoot, ...file.path.split("/"));
    try {
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        errors.push(`not a regular file: ${file.path}`);
        continue;
      }
      const actualHash = sha256(await readFile(absolutePath));
      if (actualHash !== file.sha256) {
        errors.push(`${file.path}: expected ${file.sha256}, got ${actualHash}`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        errors.push(`${file.path}: ${error.message}`);
      }
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

async function stageAssets(downloads) {
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "skimdown-vendor-"));
  try {
    for (const [relativePath, download] of downloads) {
      const stagedPath = path.join(stagingRoot, ...relativePath.split("/"));
      await mkdir(path.dirname(stagedPath), { recursive: true });
      await writeFile(stagedPath, download.bytes);
    }
    for (const relativePath of [...downloads.keys()].sort()) {
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
    await stageAssets(downloads);
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
      file.sha256 = downloads.get(file.path).sha256;
    }
    await stageAssets(downloads);
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
