# DarkPDF audit — 10 September 2026

Reproduced automatic original-document storage with no visible user choice and an inaccessible keyboard split slider. Added explicit storage opt-in for new PDFs, preserved existing saved-session recovery, and made document/metadata writes atomic. Unchecking clears saved bytes while leaving the open document usable. Storage failures report their effect.

Preservation analysis now releases its PDF worker even when page extraction fails. Annotation/image/outline read failures no longer masquerade as successful zero counts. Unexpected added links or form fields fail the comparison; analysis failures reach the user. README and landing/export language no longer promise a lossless, byte-identical document.

Browser tests no longer load dependencies from Ledger or save to personal machine paths. `npm test` runs 17 suites, including generated PDFs, sampled-check failures, storage/reload, invalid-PDF recovery, keyboard comparison and 320–1440px workspace/customization layouts. These tests complement, rather than prove, arbitrary PDF compatibility.

## Security and remaining maintenance

PDF.js 3.11.174 is still vendored. Both document-loading paths already set `isEvalSupported: false`, the [Mozilla-documented workaround for CVE-2024-4367](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq). This audit retains that mitigation and adds response CSP/permissions/MIME protections; it does not claim the library was upgraded or is free of all vulnerabilities. A supported-version migration with a representative PDF corpus remains necessary maintenance.

No document-upload or application backend exists. Opted-in originals remain browser-local, unencrypted by the app, and can contain sensitive material. Huge or adversarial PDFs can still consume browser resources. Tests do not certify signatures, all financial-document layouts, complex forms, accessibility tags or physical Safari behavior. Scanned images are intentionally not recolored. There is no financial calculation engine here; financial-document preservation must still be checked against the original.
