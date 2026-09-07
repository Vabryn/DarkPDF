// TEST 11 — the rewritten content streams are re-compressed as valid zlib
// /FlateDecode. Pins the native CompressionStream path that replaced the
// vendored pako: an independent inflater (Node zlib) must round-trip the
// output, and the stream dict must declare the filter.
const zlib = require('zlib');
const { PDFLib, PDFConverter } = require('./_boot.js');

(async () => {
  console.log('\n=== TEST 11: stream re-compression is valid zlib FlateDecode ===');
  const { PDFDocument, PDFName, PDFRawStream } = PDFLib;

  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  const raw = [
    'q',
    '0.94 0.96 0.98 rg 0 0 300 300 re f',
    '0.85 0.20 0.20 rg 20 40 120 60 re f',
    '0.10 0.30 0.75 RG 3 w 20 250 m 280 250 l S',
    'Q', ''
  ].join('\n');
  // The converter always decodes a content stream and re-encodes it, so the
  // FlateDecode payload we inspect afterwards is produced by deflateZlib
  // regardless of how the source was stored.
  const stream = doc.context.flateStream(new TextEncoder().encode(raw));
  const ref = doc.context.register(stream);
  page.node.set(PDFName.of('Contents'), ref);
  const src = await doc.save();

  const conv = new PDFConverter(); conv.setTheme('oled');
  const res = await conv.convert(src, { engine: 'stream_remap' });
  eq(res.stats.streamsFailed, 0, 'no stream failures');
  ok(res.stats.streamsChanged >= 1, 'at least one stream rewritten (' + res.stats.streamsChanged + ')');

  const out = await PDFDocument.load(res.pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = out.context;
  let checked = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const filter = obj.dict.get(PDFName.of('Filter'));
    if (!filter || filter.toString() !== '/FlateDecode') continue;
    const bytes = Buffer.from(obj.getContents());
    eq(bytes[0], 0x78, 'zlib header byte 0 (0x78) on FlateDecode stream');
    let inflated;
    try { inflated = zlib.inflateSync(bytes); } catch (e) { inflated = null; }
    ok(inflated && inflated.length > 0, 'Node zlib.inflateSync round-trips the compressed stream');
    const declaredLen = obj.dict.get(PDFName.of('Length'));
    eq(declaredLen ? declaredLen.asNumber() : -1, bytes.length, '/Length matches the compressed payload');
    checked++;
  }
  ok(checked >= 1, 'saw at least one FlateDecode stream to verify (' + checked + ')');
  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
