export function sourceLines(text) {
    const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    if (!normalized) return [];
    const lines = normalized.split("\n");
    if (normalized.endsWith("\n")) lines.pop();
    return lines;
}

// Keep comparison memory bounded. Large, highly divergent documents receive
// one accurate replacement span rather than a quadratic allocation.
export function lineDiff(oldText, newText) {
    const old = sourceLines(oldText);
    const current = sourceLines(newText);
    let start = 0;
    while (start < old.length && start < current.length && old[start] === current[start]) start++;
    let oldEnd = old.length;
    let newEnd = current.length;
    while (oldEnd > start && newEnd > start && old[oldEnd - 1] === current[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    if (oldEnd === start && newEnd === start) return [];
    const m = oldEnd - start;
    const n = newEnd - start;
    const hunk = (a, b, x, y) => ({
        oldStart: a, oldCount: b - a, newStart: x, newCount: y - x, oldLines: old.slice(a, b),
    });
    if ((m + 1) * (n + 1) > 1000000) return [hunk(start, oldEnd, start, newEnd)];
    const width = n + 1;
    const lengths = new Uint32Array((m + 1) * width);
    for (let a = m - 1; a >= 0; a--) {
        for (let b = n - 1; b >= 0; b--) {
            lengths[a * width + b] = old[start + a] === current[start + b]
                ? lengths[(a + 1) * width + b + 1] + 1
                : Math.max(lengths[(a + 1) * width + b], lengths[a * width + b + 1]);
        }
    }
    const result = [];
    let a = 0;
    let b = 0;
    while (a < m || b < n) {
        if (a < m && b < n && old[start + a] === current[start + b]) {
            a++;
            b++;
            continue;
        }
        const fromA = a;
        const fromB = b;
        while (a < m || b < n) {
            if (a < m && b < n && old[start + a] === current[start + b]) break;
            if (a < m && (b === n || lengths[(a + 1) * width + b] >= lengths[a * width + b + 1])) a++;
            else b++;
        }
        result.push(hunk(start + fromA, start + a, start + fromB, start + b));
    }
    return result;
}
