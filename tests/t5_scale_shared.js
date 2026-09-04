// TEST 5 — large doc + shared XObject: every page gets a dark ground, shared stream processed once, fast.
const { PDFLib, PDFConverter } = require('./_boot.js');
const { pageContentStrings } = require('./lib.js');

(async () => {
  console.log('\n=== TEST 5: 60 pages + shared XObject, performance & completeness ===');
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFRawStream } = PDFLib;
  const N = 60;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // one shared Form XObject referenced by every page (e.g. a running header rule)
  const zlib = require('zlib');
  const fbytes = Buffer.from(new TextEncoder().encode('q 0.85 0.85 0.85 rg 0 0 400 4 re f Q\n'));
  const fdef = zlib.deflateSync(fbytes);
  const fdict = doc.context.obj({ Type:'XObject', Subtype:'Form', FormType:1, BBox:[0,0,400,4], Resources: doc.context.obj({}) });
  fdict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  fdict.set(PDFName.of('Length'), PDFLib.PDFNumber.of(fdef.length));
  const fref = doc.context.register(PDFRawStream.of(fdict, new Uint8Array(fdef)));

  for (let i = 0; i < N; i++) {
    const page = doc.addPage([420, 595]);
    page.drawText(`Section ${i + 1}. Lorem ipsum dolor sit amet consectetur.`, { x: 40, y: 540, font, size: 11, color: rgb(0.1, 0.1, 0.1) });
    page.drawRectangle({ x: 40, y: 60, width: 340, height: 300, color: rgb(0.96, 0.96, 0.98) });
    const res = page.node.Resources();
    let xo = res.get(PDFName.of('XObject'));
    if (!xo) { xo = doc.context.obj({}); res.set(PDFName.of('XObject'), xo); }
    xo.set(PDFName.of('Hdr'), fref);
    page.node.get(PDFName.of('Contents')).push(doc.context.register(doc.context.flateStream('q 1 0 0 1 10 570 cm /Hdr Do Q\n')));
  }
  const src = await doc.save();

  const conv = new PDFConverter(); conv.setTheme('slate');
  const t0 = Date.now();
  const res = await conv.convert(src, { engine: 'stream_remap', onProgress: () => {} });
  const dt = Date.now() - t0;

  eq(res.pageCount, N, 'all 60 pages present');
  eq(res.stats.streamsFailed, 0, 'no failures across 60 pages');
  // shared header form appears once in the ref set -> streamsProcessed counts it once
  ok(res.stats.streamsProcessed <= N * 2 + 2, `shared XObject not reprocessed per page (processed ${res.stats.streamsProcessed})`);
  ok(dt < 8000, `converted 60 pages in ${dt}ms (< 8s)`);

  const after = await pageContentStrings(res.pdfBytes);
  eq(after.length, N, 'content decodes for every page');
  let groundCount = 0;
  for (const s of after) if (/\bre\s+f\b/.test(s.split('\n').slice(0, 6).join('\n'))) groundCount++;
  eq(groundCount, N, 'dark ground prepended to every page');

  const rd = await PDFDocument.load(res.pdfBytes);
  eq(rd.getPageCount(), N, 'reloads with 60 pages');
  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
