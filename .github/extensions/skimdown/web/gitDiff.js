/* Git block decorations ported with the author's permission from 07JP27/SkimDown
 * #59, commit 9da614429132d4c06ea788246eda9df3466b878b. See THIRD-PARTY-NOTICES.md. */
(function () {
  "use strict";
  // --- Git diff ---------------------------------------------------------
  // The extension sends line hunks (0-based, full document) only when Git changes are shown.
  // Blocks are classified from markdown-it token line maps; markers carry the
  // previous text as plain textContent and are never rendered as Markdown.

  const GIT_DIFF_CLASS_PREFIX = "skimdown-git-";
  const GIT_DIFF_ANCHOR_PREFIX = GIT_DIFF_CLASS_PREFIX + "anchor-";
  // Consecutive changed blocks with the same state share a run and one gutter bar.
  const GIT_DIFF_RUN_PREFIX = GIT_DIFF_CLASS_PREFIX + "run-";
  const GIT_DIFF_GUTTER_MIN_BAR_HEIGHT = 8;
  let gitDiffGutterResizeObserver = null;
  let gitDiffGutterFrame = null;
  const GIT_DIFF_UNIT_KINDS = {
    paragraph_open: "block",
    heading_open: "block",
    fence: "block",
    code_block: "block",
    hr: "block",
    html_block: "html",
    tr_open: "tr",
    math_block: "block"
  };

  function normalizedGitDiffHunks(gitDiff) {
    if (!gitDiff || !Array.isArray(gitDiff.hunks) || gitDiff.hunks.length === 0) {
      return null;
    }
    return gitDiff.hunks.map(function (hunk) {
      const oldLines = Array.isArray(hunk.oldLines) ? hunk.oldLines.map(String) : [];
      return {
        newStart: Math.max(0, Math.floor(Number(hunk.newStart) || 0)),
        newCount: Math.max(0, Math.floor(Number(hunk.newCount) || 0)),
        oldLines: oldLines,
        // Hunks that only replace blank lines are treated as pure additions.
        hasOldContent: oldLines.some(function (line) { return line.trim() !== ""; })
      };
    });
  }

  function normalizedSourceLines(text) {
    return String(text).replace(/\r\n?/g, "\n").split("\n");
  }

  function renderMarkdownWithGitDiff(markdownRenderer, source, parsedMarkdown, hunks) {
    const md = markdownRenderer;
    const env = {};
    const tokens = md.parse(parsedMarkdown.markdown, env);
    const sourceLines = normalizedSourceLines(source);
    // Token maps are relative to the body that remains after front matter removal.
    const frontMatterSource = source.slice(0, source.length - parsedMarkdown.markdown.length);
    const lineOffset = normalizedSourceLines(frontMatterSource).length - 1;
    const frontMatterLineCount = parsedMarkdown.frontMatter === null
      ? 0
      : (parsedMarkdown.markdown === "" ? sourceLines.length : lineOffset);
    const plan = planGitDiff(tokens, hunks, sourceLines, lineOffset, frontMatterLineCount);
    return { html: md.renderer.render(plan.tokens, md.options, env), plan: plan };
  }

  function planGitDiff(tokens, hunks, sourceLines, lineOffset, frontMatterLineCount) {
    const lineKinds = new Array(sourceLines.length).fill(null);
    hunks.forEach(function (hunk) {
      const end = Math.min(sourceLines.length, hunk.newStart + hunk.newCount);
      for (let line = hunk.newStart; line < end; line++) {
        lineKinds[line] = hunk.hasOldContent ? "modified" : "added";
      }
    });
    const deletionPoints = hunks.filter(function (hunk) {
      return hunk.newCount === 0 && hunk.hasOldContent;
    }).map(function (hunk) {
      return hunk.newStart;
    });

    function stateForLines(lineSet) {
      // A deletion between two lines of the same block changes that block.
      if (deletionPoints.some(function (point) { return lineSet.has(point) && lineSet.has(point - 1); })) {
        return "modified";
      }
      let hasChange = false;
      let isAllAdded = true;
      lineSet.forEach(function (line) {
        if (!(sourceLines[line] || "").trim()) {
          return;
        }
        const kind = lineKinds[line];
        hasChange = hasChange || kind !== null;
        isAllAdded = isAllAdded && kind === "added";
      });
      if (!hasChange) {
        return null;
      }
      return isAllAdded ? "added" : "modified";
    }

    const units = collectGitDiffUnits(tokens, lineOffset);
    units.forEach(function (unit) {
      unit.state = stateForLines(unit.lineSet);
      if (unit.state) {
        unit.classes.push(GIT_DIFF_CLASS_PREFIX + unit.state);
      }
    });

    const frontMatter = { classes: [], lineSet: new Set(), state: null };
    for (let line = 0; line < frontMatterLineCount; line++) {
      frontMatter.lineSet.add(line);
    }
    frontMatter.state = frontMatterLineCount > 0 ? stateForLines(frontMatter.lineSet) : null;
    if (frontMatter.state) {
      frontMatter.classes.push(GIT_DIFF_CLASS_PREFIX + frontMatter.state);
    }

    const orderedUnits = units.slice().sort(function (a, b) {
      return a.start - b.start || a.order - b.order;
    });
    const markers = [];
    hunks.forEach(function (hunk, index) {
      if (!hunk.hasOldContent) {
        return;
      }
      const target = gitDiffMarkerTarget(hunk, orderedUnits, frontMatterLineCount, frontMatter);
      if (target) {
        target.classes.push(GIT_DIFF_ANCHOR_PREFIX + index);
        // A "previous version" marker joins the bar of the modified block it precedes;
        // any other marker gets its own bar, so the run must restart after it.
        if (hunk.newCount === 0 || target.state !== "modified") {
          target.startsNewRun = true;
        }
      }
      markers.push({ id: index, hunk: hunk, atStart: target === frontMatter });
    });

    // Token order is render order (footnotes included), with front matter first.
    let runCount = 0;
    let previousState = null;
    [frontMatter].concat(units).forEach(function (unit) {
      if (unit.state && (unit.state !== previousState || unit.startsNewRun)) {
        runCount += 1;
      }
      if (unit.state) {
        unit.classes.push(GIT_DIFF_RUN_PREFIX + runCount);
      }
      previousState = unit.state;
    });

    const unitsByOrder = new Map(units.map(function (unit) { return [unit.order, unit]; }));
    const outputTokens = [];
    const sentinelTags = [];
    tokens.forEach(function (token, index) {
      const unit = unitsByOrder.get(index);
      if (unit && unit.classes.length > 0) {
        if (unit.kind === "html") {
          // html_block ignores token attributes, so a sentinel passes the classes to the element after it.
          const sentinel = new token.constructor("html_block", "", 0);
          sentinel.block = true;
          sentinel.content = "<span class=\"skimdown-git-sentinel skimdown-git-sentinel-" + sentinelTags.length +
            " " + unit.classes.join(" ") + "\"></span>";
          sentinelTags.push(unit.htmlTagName);
          outputTokens.push(sentinel);
        } else {
          unit.classes.forEach(function (className) {
            token.attrJoin("class", className);
          });
        }
      }
      outputTokens.push(token);
    });

    return {
      tokens: outputTokens,
      frontMatterClasses: frontMatter.classes,
      markers: markers,
      sentinelTags: sentinelTags
    };
  }

  // Units are the innermost blocks that receive diff classes. Everything inside a
  // list item belongs to that item, excluding the lines of nested list items.
  function collectGitDiffUnits(tokens, lineOffset) {
    const units = [];
    const openListItems = [];
    tokens.forEach(function (token, index) {
      if (token.type === "list_item_close") {
        openListItems.pop();
        return;
      }
      if (!token.map) {
        return;
      }
      const start = token.map[0] + lineOffset;
      const end = token.map[1] + lineOffset;
      if (token.type === "list_item_open") {
        const item = { order: index, kind: "li", start: start, end: end, excludedRanges: [], classes: [] };
        if (openListItems.length > 0) {
          openListItems[openListItems.length - 1].excludedRanges.push([start, end]);
        }
        openListItems.push(item);
        units.push(item);
        return;
      }
      const kind = GIT_DIFF_UNIT_KINDS[token.type];
      if (!kind || openListItems.length > 0) {
        return;
      }
      const unit = { order: index, kind: kind, start: start, end: end, excludedRanges: [], classes: [] };
      if (kind === "html") {
        const tagMatch = String(token.content).match(/^\s*<([A-Za-z][A-Za-z0-9-]*)/);
        if (!tagMatch) {
          return;
        }
        unit.htmlTagName = tagMatch[1].toLowerCase();
      }
      units.push(unit);
    });

    units.forEach(function (unit) {
      unit.lineSet = new Set();
      for (let line = unit.start; line < unit.end; line++) {
        const isExcluded = unit.excludedRanges.some(function (range) {
          return line >= range[0] && line < range[1];
        });
        if (!isExcluded) {
          unit.lineSet.add(line);
        }
      }
    });
    return units;
  }

  function gitDiffMarkerTarget(hunk, orderedUnits, frontMatterLineCount, frontMatter) {
    const start = hunk.newStart;
    const end = start + hunk.newCount;
    if (start < frontMatterLineCount) {
      return frontMatter;
    }
    let target;
    if (hunk.newCount > 0) {
      target = orderedUnits.find(function (unit) {
        for (let line = start; line < end; line++) {
          if (unit.lineSet.has(line)) {
            return true;
          }
        }
        return false;
      });
    } else {
      target = orderedUnits.find(function (unit) {
        return unit.lineSet.has(start) && unit.lineSet.has(start - 1);
      });
    }
    return target || orderedUnits.find(function (unit) { return unit.start >= start; }) || null;
  }

  function prepareGitDiffTargets(content, plan) {
    // Fence attributes are rendered on <code>; decorations belong on the <pre> block.
    content.querySelectorAll("pre > code").forEach(function (code) {
      moveGitDiffClasses(code, code.parentElement);
    });

    content.querySelectorAll(".skimdown-git-sentinel").forEach(function (sentinel) {
      const indexMatch = sentinel.className.match(/skimdown-git-sentinel-(\d+)/);
      const tagName = indexMatch ? plan.sentinelTags[Number(indexMatch[1])] : null;
      let target = sentinel.nextSibling;
      while (target && target.nodeType === Node.TEXT_NODE && !target.nodeValue.trim()) {
        target = target.nextSibling;
      }
      // If sanitization removed the HTML element, the sentinel stays as the marker anchor.
      if (!indexMatch || !target || target.nodeType !== Node.ELEMENT_NODE || target.tagName.toLowerCase() !== tagName) {
        return;
      }
      sentinel.classList.remove("skimdown-git-sentinel", indexMatch[0]);
      moveGitDiffClasses(sentinel, target);
      sentinel.remove();
    });

    const frontMatter = content.querySelector(":scope > .skimdown-frontmatter");
    if (frontMatter) {
      plan.frontMatterClasses.forEach(function (className) {
        frontMatter.classList.add(className);
      });
    }
  }

  function copyGitDiffClasses(source, target) {
    Array.from(source.classList).forEach(function (className) {
      if (className.indexOf(GIT_DIFF_CLASS_PREFIX) === 0) {
        target.classList.add(className);
      }
    });
  }

  function moveGitDiffClasses(source, target) {
    copyGitDiffClasses(source, target);
    Array.from(source.classList).forEach(function (className) {
      if (className.indexOf(GIT_DIFF_CLASS_PREFIX) === 0) {
        source.classList.remove(className);
      }
    });
    if (source.classList.length === 0) {
      source.removeAttribute("class");
    }
  }

  function insertGitDiffMarkers(content, plan) {
    plan.markers.forEach(function (marker) {
      const anchor = content.querySelector("." + GIT_DIFF_ANCHOR_PREFIX + marker.id);
      const element = gitDiffMarkerElement(marker.hunk, anchor);
      element.classList.add("skimdown-git-marker-host");
      // Matches planGitDiff: a "previous version" marker shares the bar of the modified block after it.
      const runClass = anchor ? gitDiffRunClass(anchor) : null;
      if (runClass && marker.hunk.newCount > 0 && anchor.classList.contains(GIT_DIFF_CLASS_PREFIX + "modified")) {
        element.classList.add(runClass);
      }
      if (anchor) {
        anchor.parentNode.insertBefore(element, anchor);
      } else if (marker.atStart) {
        content.insertBefore(element, content.firstChild);
      } else {
        content.appendChild(element);
      }
    });

    content.querySelectorAll("[class*='" + GIT_DIFF_ANCHOR_PREFIX + "']").forEach(function (element) {
      Array.from(element.classList).forEach(function (className) {
        if (className.indexOf(GIT_DIFF_ANCHOR_PREFIX) === 0) {
          element.classList.remove(className);
        }
      });
    });
    content.querySelectorAll(".skimdown-git-sentinel").forEach(function (sentinel) {
      sentinel.remove();
    });
  }

  function gitDiffMarkerElement(hunk, anchor) {
    const isDeletion = hunk.newCount === 0;
    const lineCount = hunk.oldLines.length;
    const details = document.createElement("details");
    details.className = "skimdown-git-marker " + (isDeletion ? "skimdown-git-marker-deleted" : "skimdown-git-marker-modified");
    const summary = document.createElement("summary");
    summary.textContent = isDeletion
      ? lineCount + (lineCount === 1 ? " line deleted" : " lines deleted")
      : "Show previous version";
    const previous = document.createElement("pre");
    previous.className = "skimdown-git-previous";
    previous.textContent = hunk.oldLines.join("\n");
    details.appendChild(summary);
    details.appendChild(previous);

    // Keep the surrounding markup valid inside lists and tables.
    const anchorTagName = anchor ? anchor.tagName : "";
    if (anchorTagName === "LI") {
      const item = document.createElement("li");
      item.className = "skimdown-git-marker-item";
      item.appendChild(details);
      return item;
    }
    if (anchorTagName === "TR") {
      const row = document.createElement("tr");
      row.className = "skimdown-git-marker-row";
      const cell = document.createElement("td");
      cell.colSpan = Math.max(1, anchor.cells.length);
      cell.appendChild(details);
      row.appendChild(cell);
      return row;
    }
    return details;
  }

  function gitDiffRunClass(element) {
    return Array.from(element.classList).find(function (className) {
      return className.indexOf(GIT_DIFF_RUN_PREFIX) === 0;
    }) || null;
  }

  // Bars are drawn in one gutter column outside #content, so every block type and
  // nesting depth lines up and code blocks or diagrams cannot clip them.
  function installGitDiffGutter(content) {
    content.classList.add("skimdown-git-diff");
    const gutter = document.createElement("div");
    gutter.className = "skimdown-git-gutter";
    gutter.setAttribute("aria-hidden", "true");
    content.appendChild(gutter);
    layoutGitDiffGutter(content, gutter);

    // Content size changes cover reflow from width changes, images, fonts,
    // Mermaid output, and opening or closing markers.
    if ("ResizeObserver" in window) {
      gitDiffGutterResizeObserver = new ResizeObserver(function () {
        if (gitDiffGutterFrame !== null) {
          return;
        }
        gitDiffGutterFrame = window.requestAnimationFrame(function () {
          gitDiffGutterFrame = null;
          if (gutter.isConnected) {
            layoutGitDiffGutter(content, gutter);
          }
        });
      });
      gitDiffGutterResizeObserver.observe(content);
    }
  }

  function teardownGitDiffGutter(content) {
    if (gitDiffGutterResizeObserver) {
      gitDiffGutterResizeObserver.disconnect();
      gitDiffGutterResizeObserver = null;
    }
    if (gitDiffGutterFrame !== null) {
      window.cancelAnimationFrame(gitDiffGutterFrame);
      gitDiffGutterFrame = null;
    }
    if (content) {
      content.classList.remove("skimdown-git-diff");
    }
  }

  function layoutGitDiffGutter(content, gutter) {
    const originTop = gutter.getBoundingClientRect().top;
    const runs = new Map();
    const bars = [];

    // Elements are looked up on every layout because Mermaid failures replace their containers.
    content.querySelectorAll("[class*='" + GIT_DIFF_RUN_PREFIX + "']").forEach(function (element) {
      const runClass = gitDiffRunClass(element);
      if (!runClass) {
        return;
      }
      let run = runs.get(runClass);
      if (!run) {
        run = { state: null, top: Infinity, bottom: -Infinity };
        runs.set(runClass, run);
        bars.push(run);
      }
      if (element.classList.contains(GIT_DIFF_CLASS_PREFIX + "added")) {
        run.state = "added";
      } else if (element.classList.contains(GIT_DIFF_CLASS_PREFIX + "modified")) {
        run.state = "modified";
      }
      const extent = gitDiffBlockExtent(element);
      if (extent) {
        run.top = Math.min(run.top, extent.top);
        run.bottom = Math.max(run.bottom, extent.bottom);
      }
    });

    content.querySelectorAll(".skimdown-git-marker-host").forEach(function (host) {
      const extent = gitDiffRunClass(host) ? null : gitDiffBlockExtent(host);
      if (!extent) {
        return;
      }
      const isDeletion = host.matches(".skimdown-git-marker-deleted") ||
        Boolean(host.querySelector(".skimdown-git-marker-deleted"));
      bars.push({ state: isDeletion ? "deleted" : "modified", top: extent.top, bottom: extent.bottom });
    });

    const fragment = document.createDocumentFragment();
    bars.forEach(function (bar) {
      if (!bar.state || !Number.isFinite(bar.top)) {
        return;
      }
      let top = bar.top;
      let height = bar.bottom - bar.top;
      if (height < GIT_DIFF_GUTTER_MIN_BAR_HEIGHT) {
        top -= (GIT_DIFF_GUTTER_MIN_BAR_HEIGHT - height) / 2;
        height = GIT_DIFF_GUTTER_MIN_BAR_HEIGHT;
      }
      const element = document.createElement("div");
      element.className = "skimdown-git-gutter-bar skimdown-git-gutter-" + bar.state;
      element.style.top = (top - originTop) + "px";
      element.style.height = height + "px";
      fragment.appendChild(element);
    });
    gutter.replaceChildren(fragment);
  }

  // Returns the vertical extent of a block in viewport coordinates. A list item
  // covers only its own lines, ending where its nested list starts.
  function gitDiffBlockExtent(element) {
    if (element.getClientRects().length === 0) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    let bottom = rect.bottom;
    if (element.tagName === "LI") {
      const nestedList = Array.from(element.children).find(function (child) {
        return child.tagName === "UL" || child.tagName === "OL";
      });
      if (nestedList) {
        bottom = Math.max(rect.top, nestedList.getBoundingClientRect().top);
      }
    }
    return { top: rect.top, bottom: bottom };
  }


  window.SkimGitDiff = { normalize: normalizedGitDiffHunks, render: renderMarkdownWithGitDiff, prepare: prepareGitDiffTargets, finish: function (content, plan) { insertGitDiffMarkers(content, plan); installGitDiffGutter(content); }, teardown: teardownGitDiffGutter };
})();
