# DarkPDF

Convert PDF colors in your browser while retaining native text and vector graphics. Documents are not uploaded. [Live app](https://darkpdf.riverakarom.com).

## Use

Drop a PDF or load the sample. Compare Split / Dark / Light, adjust the theme or Customize controls, then export. The split divider supports touch, mouse and keyboard (arrow keys, Home and End). Keep the original and inspect the conversion, particularly diagrams, scanned pages and forms.

**Remember PDF on this device** is off for new documents. Enabling it stores the original PDF and settings in this browser's IndexedDB, allowing refresh recovery. Uncheck it or return to upload to clear saved data. Older saved sessions remain restorable and show the option enabled. Browser storage is not encrypted by this app; clearing site data also removes the saved session. Exported files are separate downloads.

The app loads its assets from the host; PDF processing itself uses local, bundled code with no upload endpoint. It is not a service-worker-backed offline installation. The browser must support Web Workers and CompressionStream.

## Conversion and verification limits

The converter edits supported color operators and re-saves the PDF using pdf-lib. Text and vector objects are not rasterized. Image streams are generally left unchanged; full-page image covers are intentionally left as-is. Indexed, Separation and DeviceN colors have limited or intentionally skipped transformations.

**The entire output is not byte-identical to the source.** Saving can change object layout, compression and document metadata. Output size varies by document. Digital signatures and arbitrary third-party document structures are not certified by this tool.

After conversion, PDF.js compares page count, normalized extracted text and annotations on up to 40 sampled pages, image operators on up to 10 of those pages, and outline counts. Differences and failed verification produce warnings. Matching samples cannot prove complete semantic preservation, accessibility-tag retention, form behavior or the absence of changes on unsampled pages.

## Local development and checks

No application build step:

```bash
python3 -m http.server 8080
```

For tests, use Node 22.12+:

```bash
npm ci
npm test
```

The runner executes generated-document tests, preservation failure checks and isolated browser flows. Browser tests start a localhost server; they do not depend on another project or personal directory. Set `AUDIT_SCREENSHOTS` to retain screenshots. Fixtures cover text, images, forms, bookmarks, colorspaces, compression, math rules and shared resources. They are not an exhaustive PDF corpus.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `css/` | Interface, styling and CSP |
| `js/app.js` | Document lifecycle, customization, storage and export |
| `js/converter.js`, `js/converter.worker.js` | PDF conversion and background work |
| `js/stream-parser.js` | Tokenization and color remapping |
| `js/viewer.js` | Original/converted preview, split view and zoom |
| `js/retention.js` | Sampled preservation checks |
| `js/vendor/` | Bundled PDF.js and pdf-lib |
| `tests/` | Node and Chromium regression suites |

CJK fallback character maps are not bundled. For PDFs that require them, supply matching PDF.js `cmaps/` under `js/vendor/cmaps/` and enable `window.__DARKPDF_HAS_CMAPS__` in a local script allowed by the CSP. Embedded-font documents do not necessarily require this fallback.

Deploy from this directory with `npx wrangler@4 deploy`. Cloudflare Workers serves static assets and `_headers`; `.assetsignore` excludes tests, dependencies and documentation. Other hosts must apply equivalent security response headers. See [AUDIT.md](AUDIT.md) for security and release limits.
