// TEST 12 — a wall-to-wall image page (cover / full-bleed figure) is left
// exactly as-is: no colour remap on its content, no dark ground behind it.
const { PDFLib, PDFConverter } = require('./_boot.js');
const { pageContentStrings } = require('./lib.js');

(async () => {
  console.log('\n=== TEST 12: full-page image pages skip dark conversion ===');
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  // 2x2 PNG (same tiny asset t4 uses)
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000020000000208020000' +
    '00fdd49a730000001c4944415408d763f8cf70bfe19e01e30cc040be' +
    '9e21d80d00b7de03fb1b3f8b7f0000000049454e44ae426082', 'hex');

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(png);

  // page 1: the image covers the whole page, with a title drawn on top
  const cover = doc.addPage([400, 520]);
  cover.drawImage(img, { x: 0, y: 0, width: 400, height: 520 });
  cover.drawText('Calculus', { x: 40, y: 440, font, size: 28, color: rgb(1, 1, 1) });

  // page 2: an ordinary content page
  const body = doc.addPage([400, 520]);
  body.drawRectangle({ x: 0, y: 0, width: 400, height: 520, color: rgb(0.97, 0.97, 0.95) });
  body.drawText('Section 1.1', { x: 40, y: 470, font, size: 16, color: rgb(0.1, 0.1, 0.1) });
  body.drawRectangle({ x: 40, y: 300, width: 320, height: 60, color: rgb(0.6, 0.8, 0.25) });

  const src = await doc.save();
  const conv = new PDFConverter(); conv.setTheme('slate');   // bg #18181b
  const res = await conv.convert(src, { engine: 'stream_remap' });

  eq(res.stats.pagesLeftAsImage, 1, 'exactly one page detected as full-page image');
  eq(res.stats.streamsFailed, 0, 'no stream failures');

  const before = await pageContentStrings(src);
  const after = await pageContentStrings(res.pdfBytes);

  // page 1 (cover): content identical, no dark ground fill prepended
  eq(after[0], before[0], 'cover page content stream is byte-identical');
  ok(!/0\.0938 0\.0938 0\.10\d* rg/.test(after[0]) && !/0\.094 0\.094 0\.106 rg/.test(after[0]),
     'no dark ground painted behind the cover');
  ok(/\bDo\b/.test(after[0]), 'cover still draws its image');

  // page 2 (body): dark ground added, the lime rectangle recoloured away
  ok(after[1].length > before[1].length, 'body page gained a dark-ground prepend');
  ok(!/0\.6 0\.8 0\.25 rg/.test(after[1]), 'body page lime fill was remapped');

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
