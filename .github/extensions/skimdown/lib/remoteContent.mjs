import dns from "node:dns/promises";
import net from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

export class RemoteContentError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = "RemoteContentError";
        this.status = status;
    }
}

export function validateRemoteUrl(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 4096) {
        throw new RemoteContentError("無効なリモート URL です");
    }

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new RemoteContentError("無効なリモート URL です");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RemoteContentError("http/https のリモートコンテンツだけを読み込めます");
    }
    if (url.username || url.password) {
        throw new RemoteContentError("認証情報を含む URL は読み込めません");
    }

    const hostname = normalizedHostname(url.hostname);
    if (isLocalHostname(hostname)) {
        throw new RemoteContentError("ローカルまたはプライベートネットワークの URL は読み込めません", 403);
    }

    url.hash = "";
    return url;
}

export function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return isPublicIpv4(address);
    if (family === 6) return isPublicIpv6(address);
    return false;
}

export async function resolvePublicTarget(url, lookup = dns.lookup) {
    const hostname = normalizedHostname(url.hostname);
    const literalFamily = net.isIP(hostname);
    const addresses = literalFamily
        ? [{ address: hostname, family: literalFamily }]
        : await lookup(hostname, { all: true, verbatim: true });

    if (!Array.isArray(addresses) || addresses.length === 0) {
        throw new RemoteContentError("リモートホストを解決できません", 502);
    }
    if (addresses.some((entry) => !isPublicAddress(entry.address))) {
        throw new RemoteContentError(
            "ループバック、link-local、プライベート IP への接続は許可されていません",
            403,
        );
    }

    return addresses[0];
}

export async function fetchRemoteResource(rawUrl, options = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const lookup = options.lookup ?? dns.lookup;
    return fetchFollowingRedirects(rawUrl, { maxBytes, timeoutMs, lookup }, 0);
}

async function fetchFollowingRedirects(rawUrl, options, redirectCount) {
    const url = validateRemoteUrl(rawUrl);
    const target = await resolvePublicTarget(url, options.lookup);
    const response = await requestOnce(url, target, options.timeoutMs);

    if (isRedirect(response.statusCode) && response.headers.location) {
        response.resume();
        if (redirectCount >= MAX_REDIRECTS) {
            throw new RemoteContentError("リダイレクトが多すぎます", 502);
        }
        const next = new URL(response.headers.location, url);
        return fetchFollowingRedirects(next.toString(), options, redirectCount + 1);
    }

    if (response.statusCode !== 200) {
        response.resume();
        throw new RemoteContentError(`リモートサーバーが HTTP ${response.statusCode} を返しました`, 502);
    }

    const contentType = normalizeContentType(response.headers["content-type"]);
    if (!isAllowedMediaType(contentType)) {
        response.resume();
        throw new RemoteContentError("画像またはメディアではない応答は読み込めません", 415);
    }

    const declaredLength = Number.parseInt(response.headers["content-length"] || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        response.resume();
        throw new RemoteContentError("リモートコンテンツが大きすぎます", 413);
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
        size += chunk.length;
        if (size > options.maxBytes) {
            response.destroy();
            throw new RemoteContentError("リモートコンテンツが大きすぎます", 413);
        }
        chunks.push(chunk);
    }

    return {
        body: Buffer.concat(chunks),
        contentType,
        finalUrl: url.toString(),
    };
}

function requestOnce(url, target, timeoutMs) {
    return new Promise((resolve, reject) => {
        const request = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = request(
            {
                protocol: url.protocol,
                hostname: target.address,
                family: target.family,
                port: url.port || undefined,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                servername: normalizedHostname(url.hostname),
                headers: {
                    Host: url.host,
                    Accept: "image/*, audio/*, video/*, text/vtt;q=0.8",
                    "User-Agent": "SkimDown/1.0",
                },
            },
            resolve,
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy(new RemoteContentError("リモートコンテンツの読み込みがタイムアウトしました", 504));
        });
        req.once("error", (error) => {
            reject(
                error instanceof RemoteContentError
                    ? error
                    : new RemoteContentError(`リモートコンテンツを読み込めません: ${error.message}`, 502),
            );
        });
        req.end();
    });
}

function isRedirect(statusCode) {
    return [301, 302, 303, 307, 308].includes(statusCode);
}

function normalizeContentType(value) {
    return String(value || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
}

function isAllowedMediaType(contentType) {
    return (
        contentType.startsWith("image/") ||
        contentType.startsWith("audio/") ||
        contentType.startsWith("video/") ||
        contentType === "text/vtt" ||
        contentType === "application/ogg"
    );
}

function normalizedHostname(hostname) {
    return String(hostname || "")
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
}

function isLocalHostname(hostname) {
    if (!hostname) return true;
    if (net.isIP(hostname)) return !isPublicAddress(hostname);
    if (!hostname.includes(".")) return true;
    return (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".home") ||
        hostname.endsWith(".lan")
    );
}

function isPublicIpv4(address) {
    const parts = address.split(".").map(Number);
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        return false;
    }

    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;

    // Non-routable protocol/documentation ranges are blocked with private ranges.
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
}

function isPublicIpv6(address) {
    const value = parseIpv6(address);
    if (value === null) return false;

    // Permit only globally routable unicast (2000::/3). This excludes loopback,
    // link-local, unique-local, multicast, documentation, and IPv4-mapped ranges.
    const start = 0x20000000000000000000000000000000n;
    const end = 0x3fffffffffffffffffffffffffffffffn;
    return value >= start && value <= end;
}

function parseIpv6(address) {
    let text = address.split("%", 1)[0].toLowerCase();
    if (text.includes(".")) {
        const lastColon = text.lastIndexOf(":");
        const ipv4 = text.slice(lastColon + 1);
        const parts = ipv4.split(".").map(Number);
        if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) return null;
        text =
            text.slice(0, lastColon + 1) +
            ((parts[0] << 8) | parts[1]).toString(16) +
            ":" +
            ((parts[2] << 8) | parts[3]).toString(16);
    }

    const halves = text.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

    const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

    return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}
