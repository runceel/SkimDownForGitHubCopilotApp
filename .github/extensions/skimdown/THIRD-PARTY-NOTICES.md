# Third-party notices

SkimDown for GitHub Copilot App bundles the JavaScript and CSS assets listed below so the
canvas renders Markdown completely offline. They are shipped unmodified, exactly as they
appear in [SkimDown for Windows](https://github.com/runceel/SkimDownForWindows), under
`web/vendor/`.

The renderer itself (`web/renderer.js`, `web/renderer.html`, `web/skimdown.css`) is copied
from SkimDown for Windows, which is authored by the same author as this repository.

| Component | Version | License | Project |
| --- | --- | --- | --- |
| markdown-it | 14.1.0 | MIT | <https://github.com/markdown-it/markdown-it> |
| markdown-it-footnote | 4.0.0 | MIT | <https://github.com/markdown-it/markdown-it-footnote> |
| markdown-it-emoji | 3.0.0 | MIT | <https://github.com/markdown-it/markdown-it-emoji> |
| markdown-it-imsize | 2.0.1 | MIT | <https://github.com/tatsy/markdown-it-imsize> |
| highlight.js | 11.10.0 | BSD-3-Clause | <https://github.com/highlightjs/highlight.js> |
| highlight.js themes (`github`, `github-dark`) | 11.10.0 | BSD-3-Clause | <https://github.com/highlightjs/highlight.js> |
| DOMPurify | 3.1.6 | Apache-2.0 OR MPL-2.0 | <https://github.com/cure53/DOMPurify> |
| KaTeX | 0.16.22 | MIT | <https://github.com/KaTeX/KaTeX> |
| KaTeX fonts (`web/vendor/katex/fonts/*.woff2`) | 0.16.22 | SIL Open Font License 1.1 | <https://github.com/KaTeX/KaTeX> |
| Mermaid | 11.15.0 | MIT | <https://github.com/mermaid-js/mermaid> |

Each project's full license text is available in its repository at the version listed above.

Exact file hashes, the pinned upstream revision, official package sources, and the generated
CycloneDX inventory are recorded in
[`vendor-lock.json`](vendor-lock.json) and [`vendor-sbom.cdx.json`](vendor-sbom.cdx.json).
