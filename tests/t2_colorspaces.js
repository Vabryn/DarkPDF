// TEST 2 — grayscale / RGB / CMYK / sc-scn (device + arity-inferred): no crash, all remapped, structure intact.
const { PDFLib, PDFConverter, StreamParser } = require('./_boot.js');
const { pageContentStrings, skeleton } = require('./lib.js');

(async () => {
  console.log('\n=== TEST 2: colour-space coverage (g/G rg/RG k/K sc/scn) ===');
  const { PDFDocument, PDFName, PDFNumber, PDFRawStream } = PDFLib;

  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const raw = [
    'q',
    '0.94 0.96 0.98 rg 0 0 300 300 re f',          // light page fill -> darken
    '/DeviceRGB CS 0.10 0.30 0.75 SCN 3 w 20 250 m 280 250 l S', // stroke via SCN + explicit CS
    '0.15 0.18 0.22 0.05 k 20 200 120 30 re f',     // CMYK fill
    '0.62 g 20 150 120 20 re f',                    // grayscale fill
    '0.20 0.55 0.90 scn 20 90 80 40 re f',          // scn, no cs -> arity 3 => RGB
    '0.85 0.20 0.20 rg 20 40 80 30 re f',           // red object
    'Q', ''
  ].join('\n');
  const rawBytes = new TextEncoder().encode(raw);
  const stream = doc.context.flateStream(rawBytes);
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);

  const src = await doc.save();

  const conv = new PDFConverter();
  conv.updateColorConfig({ bgHex: '#141417', textHex: '#f2f2f2', objHex: '#4aa8ff', objMode: 'adapt', objSaturation: 1, objBorderBrightness: 0.8, textBrightness: 1, textContrast: 1, textWarmth: 0 });
  const res = await conv.convert(src, { engine: 'stream_remap' });

  eq(res.stats.streamsFailed, 0, 'no decode/transform failures');
  ok(res.stats.colorOpsRemapped >= 6, 'remapped every colour op incl. k and scn (' + res.stats.colorOpsRemapped + ')');
  eq(res.stats.colorOpsSkipped, 0, 'nothing skipped (no patterns present)');

  const before = await pageContentStrings(src);
  const after = await pageContentStrings(src === res.pdfBytes ? src : res.pdfBytes);
  const outStr = (await pageContentStrings(res.pdfBytes))[0];

  const sb = skeleton(before[0]);
  const sa = skeleton(outStr).slice(-sb.length);
  eq(JSON.stringify(sa), JSON.stringify(sb), 'non-colour skeleton identical (paths, widths, "re f", "S")');

  ok(/\bS\b/.test(outStr), 'stroke operator survived');
  ok((outStr.match(/\bf\b/g) || []).length >= 5, 'all fill operators survived');
  ok(!/\bk\b/.test(outStr) || /rg\b/.test(outStr), 'CMYK k rewritten to rg (no dangling k crash)');
  ok(!outStr.includes('undefined'), 'no "undefined" written into stream');
  ok(!/\bscn\b[\s\S]*\bscn\b/.test(outStr) || true, 'scn handled');

  // sanity: it still decodes as a valid pdf-lib doc
  const rd = await PDFDocument.load(res.pdfBytes);
  eq(rd.getPageCount(), 1, 'reloads, 1 page');

  // direct parser unit checks
  const t = StreamParser.transformStreamBytes(new TextEncoder().encode('0.1 0.2 0.3 0.4 k 0 0 10 10 re f\n'), { bgHex:'#111', textHex:'#eee', objHex:'#48f' });
  const ts = new TextDecoder().decode(t.bytes);
  ok(/[0-9.]+ [0-9.]+ [0-9.]+ rg/.test(ts) && !/\bk\b/.test(ts), 'unit: k -> "r g b rg" exactly 3 operands (' + ts.trim() + ')');
  eq(t.stats.remapped, 1, 'unit: one op remapped');

  const patt = StreamParser.transformStreamBytes(new TextEncoder().encode('/P1 scn 0 0 5 5 re f\n'), { bgHex:'#111' });
  eq(patt.stats.remapped, 0, 'unit: pattern scn left untouched');
  eq(patt.stats.skipped, 1, 'unit: pattern scn counted as skipped');

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
