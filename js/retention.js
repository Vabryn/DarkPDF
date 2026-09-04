/**
 * retention.js
 * Automated before/after data-integrity check.
 *
 * Loads the original and the converted PDF side by side with pdf.js and
 * compares the things a colour-only conversion must never change: page count,
 * extracted text (per sampled page, exact match), link annotations, form-field
 * widgets, image draw operations, bookmarks, and file-size growth.
 */

(function (window) {
  'use strict';

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function samplePages(total, cap) {
    if (total <= cap) return Array.from({ length: total }, (_, i) => i + 1);
    const out = new Set();
    for (let i = 0; i < cap; i++) out.add(Math.round(1 + (i * (total - 1)) / (cap - 1)));
    return Array.from(out).sort((a, b) => a - b);
  }

  function countOutline(items) {
    if (!Array.isArray(items)) return 0;
    let n = 0;
    for (const it of items) n += 1 + countOutline(it.items);
    return n;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  const RetentionCheck = {

    async analyze(pdfjsLib, bytes, opts = {}) {
      const maxPages = opts.maxPages || 40;
      const imgPages = opts.imgPages || 10;

      const params = { data: bytes.slice(0), useSystemFonts: true, isEvalSupported: false };
      if (window.__DARKPDF_HAS_CMAPS__) { params.cMapUrl = 'js/vendor/cmaps/'; params.cMapPacked = true; }
      const doc = await pdfjsLib.getDocument(params).promise;

      const total = doc.numPages;
      const pages = samplePages(total, maxPages);
      const perPageText = {};
      let textLen = 0, links = 0, widgets = 0, images = 0;

      for (let idx = 0; idx < pages.length; idx++) {
        const page = await doc.getPage(pages[idx]);

        const tc = await page.getTextContent();
        let s = '';
        for (const it of tc.items) s += (it.str || '') + (it.hasEOL ? '\n' : '');
        perPageText[pages[idx]] = norm(s);
        textLen += perPageText[pages[idx]].length;

        try {
          for (const a of await page.getAnnotations()) {
            if (a.subtype === 'Link') links++;
            else if (a.subtype === 'Widget') widgets++;
          }
        } catch (e) {}

        if (idx < imgPages) {
          try {
            const O = pdfjsLib.OPS;
            for (const fn of (await page.getOperatorList()).fnArray) {
              if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject ||
                  fn === O.paintImageMaskXObject || fn === O.paintJpegXObject ||
                  fn === O.paintImageXObjectRepeat) images++;
            }
          } catch (e) {}
        }
      }

      let outline = 0;
      try { outline = countOutline(await doc.getOutline()); } catch (e) {}
      try { await doc.destroy(); } catch (e) {}

      return { total, pagesChecked: pages, imgPagesChecked: Math.min(imgPages, pages.length),
               textLen, links, widgets, images, outline, perPageText, size: bytes.length };
    },

    compare(before, after) {
      const rows = [];
      const row = (label, b, a, ok, note) => rows.push({ label, before: b, after: a, ok, note: note || '' });

      let textMatch = 0;
      for (const p of before.pagesChecked) {
        if (norm(before.perPageText[p]) === norm(after.perPageText[p])) textMatch++;
      }
      const n = before.pagesChecked.length;

      row('Pages', before.total, after.total, before.total === after.total);
      row('Text identical', `${n} pages`, `${textMatch}/${n}`, textMatch === n,
          textMatch === n ? 'every sampled page' : `${n - textMatch} differ`);
      row('Text characters', before.textLen.toLocaleString(), after.textLen.toLocaleString(),
          after.textLen >= before.textLen - 2, 'sampled');
      row('Link annotations', before.links, after.links, after.links >= before.links);
      row('Form fields', before.widgets, after.widgets, after.widgets >= before.widgets);
      row('Image draws', before.images, after.images, after.images === before.images,
          `${before.imgPagesChecked} pages sampled`);
      row('Bookmarks', before.outline, after.outline, after.outline === before.outline);

      const growth = before.size ? (after.size - before.size) / before.size : 0;
      row('File size', fmtBytes(before.size), fmtBytes(after.size), growth <= 0.4,
          `${growth >= 0 ? '+' : ''}${(growth * 100).toFixed(1)}%`);

      // "critical" = things a lossless conversion must never break; file size is expected to move
      const criticalPass = rows.filter((r) => r.label !== 'File size').every((r) => r.ok);
      return { rows, criticalPass };
    }
  };

  window.RetentionCheck = RetentionCheck;
})(typeof window !== 'undefined' ? window : this);
