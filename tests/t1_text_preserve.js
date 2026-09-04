// TEST 1 — plain text document, stream_remap: prove ONLY colour changed.
const { PDFLib, PDFConverter } = require('./_boot.js');
const { pageContentStrings, skeleton, docInfo } = require('./lib.js');

(async () => {
  console.log('\n=== TEST 1: text document, stream_remap preserves everything but colour ===');
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Page ${p + 1}: The quick brown fox jumps over the lazy dog.`, { x: 50, y: 780, font, size: 12, color: rgb(0, 0, 0) });
    page.drawText('Sub-heading in dark grey', { x: 50, y: 740, font, size: 14, color: rgb(0.2, 0.2, 0.2) });
    page.drawText('A blue hyperlink-like line', { x: 50, y: 700, font, size: 12, color: rgb(0.1, 0.3, 0.75) });
    page.drawRectangle({ x: 50, y: 600, width: 495, height: 2, color: rgb(0, 0, 0) });
  }
  const src = await doc.save();

  const conv = new PDFConverter();
  conv.setTheme('slate');
  const res = await conv.convert(src, { engine: 'stream_remap' });
  ok(res.pdfBytes.length > 0, 'produced output bytes');
  eq(res.stats.streamsFailed, 0, 'no streams failed to decode');
  ok(res.stats.colorOpsRemapped >= 12, 'remapped colour ops on all pages (' + res.stats.colorOpsRemapped + ')');

  const before = await pageContentStrings(src);
  const after = await pageContentStrings(res.pdfBytes);
  eq(after.length, before.length, 'page count preserved');

  for (let i = 0; i < before.length; i++) {
    // strip the prepended dark-ground stream from the "after" comparison:
    // skeleton() already drops colour ops incl. the "re f" of the bg? No -> bg adds "re f".
    const sb = skeleton(before[i]);
    const sa = skeleton(after[i]).slice(-sb.length); // bg ground prepends "q ... re f Q"
    eq(JSON.stringify(sa), JSON.stringify(sb), `page ${i + 1}: non-colour token skeleton identical`);
    ok(/BT[\s\S]*ET/.test(after[i]), `page ${i + 1}: text objects (BT..ET) intact`);
    ok(after[i].includes('Tj') || after[i].includes('TJ'), `page ${i + 1}: text-show operator intact`);
    ok(after[i] !== before[i], `page ${i + 1}: bytes actually changed (colour)`);
  }

  const bi = await docInfo(src), ai = await docInfo(res.pdfBytes);
  eq(ai.pages, bi.pages, 'docInfo page count');
  ok(ai.size < bi.size * 3, `size sane (${bi.size} -> ${ai.size})`);

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
