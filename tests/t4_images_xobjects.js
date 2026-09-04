// TEST 4 — image XObjects are byte-identical (never recoloured); Form XObjects ARE recoloured.
const { PDFLib, PDFConverter } = require('./_boot.js');
const { imageStreamBytes } = require('./lib.js');
const zlib = require('zlib');

(async () => {
  console.log('\n=== TEST 4: images untouched, form xobjects recoloured ===');
  const { PDFDocument, PDFName, PDFRawStream, rgb } = PDFLib;

  // 2x2 RGB PNG (red, green / blue, white)
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000020000000208020000' +
    '00fdd49a730000001c4944415408d763f8cf70bfe19e01e30cc040be' +
    '9e21d80d00b7de03fb1b3f8b7f0000000049454e44ae426082', 'hex');

  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 10, y: 10, width: 80, height: 80 });

  // add a Form XObject with a coloured rectangle inside
  const formContent = new TextEncoder().encode('q 0.93 0.95 0.97 rg 0 0 50 50 re f 0 0 0 RG 1 w 0 0 50 50 re S Q\n');
  const formDict = doc.context.obj({
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, 50, 50], Resources: doc.context.obj({})
  });
  const deflated = zlib.deflateSync(Buffer.from(formContent));
  formDict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
  formDict.set(PDFName.of('Length'), PDFLib.PDFNumber.of(deflated.length));
  const formRef = doc.context.register(PDFRawStream.of(formDict, new Uint8Array(deflated)));

  // reference the form from the page resources + content
  const res = page.node.Resources();
  let xo = res.get(PDFName.of('XObject'));
  xo.set(PDFName.of('Fm0'), formRef);
  const pageContentRef = page.node.get(PDFName.of('Contents'));
  const arr = pageContentRef;
  // append "/Fm0 Do" via a new content stream
  const doStream = doc.context.flateStream('q 1 0 0 1 110 110 cm /Fm0 Do Q\n');
  arr.push(doc.context.register(doStream));

  const src = await doc.save();
  const beforeImgs = await imageStreamBytes(src);
  ok(Object.keys(beforeImgs).length >= 1, 'source contains an image XObject');

  const conv = new PDFConverter(); conv.setTheme('slate');
  const res2 = await conv.convert(src, { engine: 'stream_remap' });
  const afterImgs = await imageStreamBytes(res2.pdfBytes);

  eq(Object.keys(afterImgs).length, Object.keys(beforeImgs).length, 'image XObject count unchanged');
  let identical = true;
  for (const tag of Object.keys(beforeImgs)) {
    if (!afterImgs[tag] || afterImgs[tag] !== beforeImgs[tag]) identical = false;
  }
  ok(identical, 'every image XObject stream is byte-for-byte identical');
  eq(res2.stats.streamsFailed, 0, 'no stream failures');
  ok(res2.stats.streamsChanged >= 1, 'at least the form xobject / page content changed');

  // confirm the Form XObject content was recoloured (0.1 0.2 0.9 rg no longer present verbatim)
  const rd = await PDFDocument.load(res2.pdfBytes);
  let formStr = '';
  for (const [ref, obj] of rd.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const st = obj.dict.get(PDFName.of('Subtype'));
      if (st && st.toString() === '/Form') {
        formStr = new TextDecoder('latin1').decode(PDFLib.decodePDFRawStream(obj).decode());
      }
    }
  }
  ok(formStr.length > 0, 'form xobject still present & decodable');
  ok(/re\s+f/.test(formStr) && /Q\s*$/.test(formStr.trim() + '\n'), 'form xobject path ops intact');
  ok(!formStr.includes('0.93 0.95 0.97 rg'), 'form xobject light fill was remapped to dark ground');
  ok(res2.stats.colorOpsRemapped >= 2, 'form xobject fill + stroke both remapped');

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
