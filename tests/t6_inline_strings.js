// TEST 6 — inline images and string literals containing operator-like bytes are NOT corrupted.
const { PDFLib, PDFConverter, StreamParser } = require('./_boot.js');

(async () => {
  console.log('\n=== TEST 6: inline images + adversarial string literals ===');
  const { PDFDocument, PDFName } = PDFLib;

  // content stream with: a string literal that contains "1 0 0 rg", nested parens,
  // and an inline image whose binary blob contains bytes that look like "0 0 0 rg".
  const tricky =
    'q\n' +
    'BT /F1 12 Tf 40 700 Td (Colour spec: 1 0 0 rg (do not parse) \\) still text) Tj ET\n' +
    '0 0 0 rg 40 600 100 20 re f\n' +
    'q 100 0 0 100 40 400 cm\n' +
    'BI /W 4 /H 1 /CS /RGB /BPC 8 ID \x00\x00\x00rg\x20\x01\x02\x03\x00\x00\x00\x00\x00\x00 EI\n' +
    'Q\n' +
    '0.5 0.5 0.5 rg 40 300 100 20 re f\n' +
    'Q\n';
  const buf = new TextEncoder().encode(tricky);
  // count operator-looking colour ops the parser SHOULD touch: the two real "rg" (line 3 and last)
  const out = StreamParser.transformStreamBytes(buf, { bgHex: '#141414', textHex: '#eaeaea', objHex: '#48a' });
  const s = new TextDecoder('latin1').decode(out.bytes);

  eq(out.stats.remapped, 2, 'exactly the 2 real object colour ops remapped (fake rg inside string ignored)');
  ok(s.includes('(Colour spec: 1 0 0 rg (do not parse) \\) still text) Tj'), 'string literal with fake "rg" left verbatim');
  ok(s.includes('BI /W 4 /H 1 /CS /RGB /BPC 8 ID'), 'inline image header intact');
  ok(s.includes('\x00\x00\x00rg\x20\x01\x02\x03\x00\x00\x00\x00\x00\x00 EI'), 'inline image binary blob byte-identical');
  ok(!/\x00\x00\x00[0-9.]+ [0-9.]+ [0-9.]+ rg/.test(s), 'no splice landed inside the image blob');

  // full pipeline: make a real PDF using this stream, convert, ensure valid + decodable
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 760]);
  const ref = doc.context.register(doc.context.flateStream(buf));
  page.node.set(PDFName.of('Contents'), ref);
  const src = await doc.save();
  const conv = new PDFConverter();
  const res = await conv.convert(src, { engine: 'stream_remap' });
  eq(res.stats.streamsFailed, 0, 'pipeline: no failures on tricky stream');
  const rd = await PDFDocument.load(res.pdfBytes);
  eq(rd.getPageCount(), 1, 'pipeline: output reloads');
  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
