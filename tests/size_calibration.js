// SIZE CALIBRATION — measure real orig->output sizes for varied PDFs across
// both lossless engines and check the app's estimateOutputSize() band.
const { PDFLib, PDFConverter } = require('./_boot.js');
const zlib = require('zlib');

// KEEP IN LOCK-STEP with js/app.js estimateOutputSize()
function estimateOutputSize(origSize, pageCount, engine) {
  const p = Math.max(1, pageCount);
  if (engine === 'scanned_canvas') return { lo: origSize * 0.30, hi: origSize * 2.0 };
  return { lo: origSize * 0.95, hi: origSize * 1.35 + p * 45 + 500 };
}

async function textDoc(pages, rows) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const fb = await d.embedFont(StandardFonts.HelveticaBold);
  for (let p = 0; p < pages; p++) {
    const pg = d.addPage([595, 842]);
    pg.drawText(`Chapter ${p + 1}`, { x: 50, y: 800, font: fb, size: 14, color: rgb(0.1, 0.1, 0.1) });
    for (let i = 0; i < rows; i++) {
      if (i % 2 === 0) pg.drawRectangle({ x: 50, y: 770 - i * 22 - 4, width: 495, height: 20, color: rgb(0.95, 0.96, 0.98) });
      pg.drawText(`${i + 1}. Measurement ${i}: value ${(i * 3.14).toFixed(2)} — a fairly long descriptive label here.`, { x: 56, y: 770 - i * 22, font: f, size: 9.5, color: rgb(0.2, 0.2, 0.2) });
    }
    pg.drawRectangle({ x: 50, y: 90, width: 495, height: 2, color: rgb(0, 0, 0) });
  }
  return d.save();
}

async function withImage() {
  const { PDFDocument, StandardFonts, PDFName, PDFRawStream, PDFNumber, rgb } = PDFLib;
  const src = await textDoc(8, 20);
  const d = await PDFDocument.load(src);
  const blob = Buffer.alloc(4000, 7);
  const defl = zlib.deflateSync(blob);
  const dict = d.context.obj({ Type: 'XObject', Subtype: 'Image', Width: 40, Height: 40, BitsPerComponent: 8, ColorSpace: 'DeviceRGB' });
  dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  dict.set(PDFName.of('Length'), PDFNumber.of(defl.length));
  const ref = d.context.register(PDFRawStream.of(dict, new Uint8Array(defl)));
  const pg = d.getPages()[0];
  pg.node.Resources().get(PDFName.of('XObject')).set(PDFName.of('Im0'), ref);
  pg.node.get(PDFName.of('Contents')).push(d.context.register(d.context.flateStream('q 60 0 0 60 470 740 cm /Im0 Do Q\n')));
  return d.save();
}

(async () => {
  console.log('\n=== SIZE CALIBRATION: estimate band vs actual ===');
  const cases = [
    ['small 3pg', await textDoc(3, 24)],
    ['medium 12pg', await textDoc(12, 22)],
    ['with image 8pg', await withImage()],
    ['large 60pg', await textDoc(60, 22)]
  ];
  for (const [label, src] of cases) {
    for (const engine of ['stream_remap']) {
      const conv = new PDFConverter(); conv.setTheme('slate');
      const res = await conv.convert(src, { engine });
      const est = estimateOutputSize(src.length, res.pageCount, engine);
      const inBand = res.pdfBytes.length >= est.lo && res.pdfBytes.length <= est.hi;
      const err = ((res.pdfBytes.length - (est.lo + est.hi) / 2) / res.pdfBytes.length * 100);
      console.log(`  ${(label + ' / ' + engine).padEnd(34)} orig=${(src.length / 1024).toFixed(1)}KB out=${(res.pdfBytes.length / 1024).toFixed(1)}KB  x${(res.pdfBytes.length / src.length).toFixed(3)}  band=[${(est.lo / 1024).toFixed(1)}..${(est.hi / 1024).toFixed(1)}]KB  midErr=${err.toFixed(0)}%`);
      ok(inBand, `${label} / ${engine}: actual inside estimate band`);
      eq(res.stats.streamsFailed || 0, 0, `${label} / ${engine}: no stream failures`);
    }
  }
  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
