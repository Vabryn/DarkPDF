// TEST 3 — annotations, form fields, bookmarks/outline survive both lossless engines.
const { PDFLib, PDFConverter } = require('./_boot.js');
const { docInfo } = require('./lib.js');

(async () => {
  console.log('\n=== TEST 3: annotations / form fields / bookmarks preserved ===');
  const { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFDict, PDFString } = PDFLib;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 500]);
  const p2 = doc.addPage([400, 500]);
  p1.drawText('See page 2', { x: 40, y: 440, font, size: 14, color: rgb(0, 0, 0.8) });
  p2.drawText('Target', { x: 40, y: 440, font, size: 14, color: rgb(0, 0, 0) });

  // form text field
  const form = doc.getForm();
  const tf = form.createTextField('user.name');
  tf.addToPage(p1, { x: 40, y: 380, width: 200, height: 20 });

  // manual Link annotation on p1 -> p2
  const ctx = doc.context;
  const linkDict = ctx.obj({
    Type: 'Annot', Subtype: 'Link',
    Rect: [40, 430, 140, 452],
    Border: [0, 0, 0],
    Dest: undefined
  });
  linkDict.set(PDFName.of('A'), ctx.obj({ Type: 'Action', S: 'GoTo', D: [p2.ref, PDFName.of('XYZ'), null, null, null] }));
  const linkRef = ctx.register(linkDict);
  let annots = p1.node.get(PDFName.of('Annots'));
  if (!annots) { annots = ctx.obj([]); p1.node.set(PDFName.of('Annots'), annots); }
  annots.push(linkRef);

  // outline / bookmarks
  const outlineRef = ctx.nextRef();
  const item1 = ctx.obj({ Title: PDFString.of('Chapter 1'), Dest: [p1.ref, PDFName.of('Fit')] });
  const item2 = ctx.obj({ Title: PDFString.of('Chapter 2'), Dest: [p2.ref, PDFName.of('Fit')] });
  const i1 = ctx.register(item1), i2 = ctx.register(item2);
  const outlines = ctx.obj({ Type: 'Outlines', First: i1, Last: i2, Count: 2 });
  item1.set(PDFName.of('Parent'), outlineRef); item1.set(PDFName.of('Next'), i2);
  item2.set(PDFName.of('Parent'), outlineRef); item2.set(PDFName.of('Prev'), i1);
  ctx.assign(outlineRef, outlines);
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);

  const src = await doc.save();
  const bi = await docInfo(src);
  ok(bi.links >= 1, 'source has a link annotation');
  ok(bi.widgets >= 1, 'source has a form field widget');
  ok(bi.hasOutline, 'source has an outline');
  ok(bi.hasAcroForm, 'source has an AcroForm');

  for (const engine of ['stream_remap']) {
    const conv = new PDFConverter(); conv.setTheme('oled');
    const res = await conv.convert(src, { engine });
    const ai = await docInfo(res.pdfBytes);
    eq(ai.pages, bi.pages, `${engine}: page count`);
    eq(ai.links, bi.links, `${engine}: link annotations preserved`);
    eq(ai.widgets, bi.widgets, `${engine}: form field widgets preserved`);
    eq(ai.hasOutline, true, `${engine}: outline preserved`);
    eq(ai.hasAcroForm, true, `${engine}: AcroForm preserved`);
    const rd = await PDFDocument.load(res.pdfBytes);
    eq(rd.getForm().getFields().length, 1, `${engine}: form field readable after convert`);
  }
  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
