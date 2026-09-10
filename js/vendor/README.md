# Bundled PDF libraries

- `pdf.min.js` and `pdf.worker.min.js`: Mozilla PDF.js **3.11.174**; the matching viewer CSS is `css/pdf_viewer.min.css`. [Upstream release](https://github.com/mozilla/pdf.js/releases/tag/v3.11.174). Apache 2.0; see `PDFJS-LICENSE.txt` and embedded notices.
- `pdf-lib.min.js`: pdf-lib browser bundle. The repository did not record its release version; do not infer a verified version from the filename. [Upstream project](https://github.com/Hopding/pdf-lib). MIT; see `PDFLIB-LICENSE.txt` and the notices embedded for bundled dependencies.

The application's proprietary license does not replace these third-party licenses. Preserve notices when distributing the assets. Verify release provenance and run all PDF/browser tests when replacing a bundle; update worker and renderer together. See the project audit for the PDF.js security mitigation and upgrade requirement.
