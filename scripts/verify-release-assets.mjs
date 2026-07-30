import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const manifestPath = path.join(scriptDirectory, "katex-0.16.22-fonts.sha256");
const fontDirectory = ".github/extensions/skimdown/web/vendor/katex/fonts";

function parseManifest(contents) {
    const entries = [];
    const seenPaths = new Set();

    for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }

        const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
        if (!match) {
            throw new Error(`Invalid manifest entry on line ${index + 1}`);
        }

        const [, expectedHash, relativePath] = match;
        if (seenPaths.has(relativePath)) {
            throw new Error(`Duplicate manifest path: ${relativePath}`);
        }

        seenPaths.add(relativePath);
        entries.push({ expectedHash, relativePath });
    }

    if (entries.length === 0) {
        throw new Error("The release asset manifest is empty");
    }

    return entries;
}

function verifyGitAttributes(entries) {
    const result = spawnSync(
        "git",
        ["check-attr", "text", "--", ...entries.map(({ relativePath }) => relativePath)],
        { cwd: repositoryRoot, encoding: "utf8" },
    );

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || "git check-attr failed");
    }

    const attributes = new Map();
    for (const line of result.stdout.trim().split(/\r?\n/)) {
        const match = /^(.*): text: (.*)$/.exec(line);
        if (match) {
            attributes.set(match[1], match[2]);
        }
    }

    for (const { relativePath } of entries) {
        const textAttribute = attributes.get(relativePath);
        if (textAttribute !== "unset") {
            throw new Error(
                `${relativePath} must have text: unset, but git reported ${textAttribute ?? "no value"}`,
            );
        }
    }
}

async function verifyManifestCoverage(entries) {
    const expectedPaths = entries.map(({ relativePath }) => relativePath).sort();
    const actualPaths = (await readdir(path.join(repositoryRoot, ...fontDirectory.split("/"))))
        .filter((name) => name.endsWith(".woff2"))
        .map((name) => `${fontDirectory}/${name}`)
        .sort();

    if (expectedPaths.length !== actualPaths.length ||
        expectedPaths.some((expectedPath, index) => expectedPath !== actualPaths[index])) {
        throw new Error("The manifest must list every bundled KaTeX .woff2 file exactly once");
    }
}

async function verifyHashes(entries) {
    for (const { expectedHash, relativePath } of entries) {
        const absolutePath = path.join(repositoryRoot, ...relativePath.split("/"));
        const actualHash = createHash("sha256")
            .update(await readFile(absolutePath))
            .digest("hex");

        if (actualHash !== expectedHash) {
            throw new Error(`${relativePath} has SHA-256 ${actualHash}; expected ${expectedHash}`);
        }
    }
}

async function main() {
    const entries = parseManifest(await readFile(manifestPath, "utf8"));
    verifyGitAttributes(entries);
    await verifyManifestCoverage(entries);
    await verifyHashes(entries);
    console.log(`Verified ${entries.length} KaTeX fonts and their Git text attributes.`);
}

main().catch((error) => {
    console.error(`Release asset verification failed: ${error.message}`);
    process.exitCode = 1;
});
