# Third-party notices

SkimDown for GitHub Copilot App bundles the JavaScript and CSS assets listed below so the
canvas renders Markdown completely offline. They are shipped unmodified, exactly as they
appear in [SkimDown for Windows](https://github.com/runceel/SkimDownForWindows), under
`web/vendor/`.

The renderer assets (`web/renderer.js`, `web/renderer.html`, `web/skimdown.css`) are
derived from SkimDown for Windows, which is authored by the same author as this
repository. This repository may carry narrowly scoped security hardening in
`web/renderer.js` until the corresponding upstream change is available.

| Component | Version | License | Project |
| --- | --- | --- | --- |
| markdown-it | 14.1.0 | MIT | <https://github.com/markdown-it/markdown-it> |
| markdown-it-footnote | 4.0.0 | MIT | <https://github.com/markdown-it/markdown-it-footnote> |
| markdown-it-emoji | 3.0.0 | MIT | <https://github.com/markdown-it/markdown-it-emoji> |
| markdown-it-imsize | 2.0.1 | MIT | <https://github.com/tatsy/markdown-it-imsize> |
| highlight.js | 11.10.0 | BSD-3-Clause | <https://github.com/highlightjs/highlight.js> |
| highlight.js themes (`github`, `github-dark`) | 11.10.0 | BSD-3-Clause | <https://github.com/highlightjs/highlight.js> |
| DOMPurify | 3.4.12 | Apache-2.0 OR MPL-2.0 | <https://github.com/cure53/DOMPurify> |
| KaTeX | 0.16.22 | MIT | <https://github.com/KaTeX/KaTeX> |
| KaTeX fonts (`web/vendor/katex/fonts/*.woff2`) | 0.16.22 | SIL Open Font License 1.1 | <https://github.com/KaTeX/KaTeX> |
| Mermaid | 11.15.0 | MIT | <https://github.com/mermaid-js/mermaid> |

Each project's full license text is available in its repository at the version listed above.

The vendored DOMPurify bundle was downloaded from the upstream
[`3.4.12` release](https://github.com/cure53/DOMPurify/releases/download/3.4.12/purify.min.js).
Its SHA-256 digest is
`c45ba939765574f96cbf35ee9b6d89f73756a17921814425e74b82f7c54603ce`.
