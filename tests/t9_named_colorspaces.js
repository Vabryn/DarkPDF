// TEST 9 — named resource colour spaces resolved via converter's ColorSpace map.
const { PDFLib, PDFConverter, StreamParser } = require('./_boot.js');
const { pageContentStrings, skeleton } = require('./lib.js');
const zlib = require('zlib');

(async () => {
  console.log('\n=== TEST 9: ICCBased / Indexed / Separation scn handling ===');
  const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFArray } = PDFLib;

  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;

  // ICCBased RGB (N=3) stream
  const iccRgb = ctx.stream(new Uint8Array(3), { N: 3 });
  const iccRgbRef = ctx.register(iccRgb);
  // ICCBased Gray (N=1)
  const iccGray = ctx.stream(new Uint8Array(1), { N: 1 });
  const iccGrayRef = ctx.register(iccGray);

  // multi-colorant DeviceN — deliberately out of scope, must stay 'skip'
  const csDNFn = ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0], C1: [1, 1, 1], N: 1 });

  const csDict = ctx.obj({
    CsRGB: ctx.obj(['ICCBased', iccRgbRef]),
    CsGray: ctx.obj(['ICCBased', iccGrayRef]),
    CsIdx: ctx.obj(['Indexed', 'DeviceRGB', 1, PDFLib.PDFString.of('\x00\x00\x00\xff\xff\xff')]),
    // simple, directly-evaluable Type2 tint transform -> now resolved, not skipped
    CsSep: ctx.obj(['Separation', 'Spot1', 'DeviceCMYK', ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0, 0], C1: [0, 0, 0, 1], N: 1 })]),
    CsDN: ctx.obj(['DeviceN', ctx.obj(['C1', 'C2']), 'DeviceRGB', csDNFn])
  });
  const res = page.node.Resources();
  res.set(PDFName.of('ColorSpace'), csDict);

  const content =
    'q\n' +
    '/CsRGB cs 0.1 0.3 0.75 scn 10 160 80 30 re f\n' +   // ICC RGB -> remap
    '/CsGray cs 0.15 scn 10 120 80 30 re f\n' +           // ICC Gray -> remap (arity 1)
    '/CsIdx cs 1 scn 10 80 80 30 re f\n' +                // Indexed -> MUST be skipped (1 = palette index)
    '/CsSep cs 0.8 scn 10 40 80 30 re f\n' +              // Separation, simple fn -> now remapped
    '/CsDN cs 0.5 0.5 scn 10 0 80 30 re f\n' +            // DeviceN (2 colorants) -> out of scope, MUST skip
    'Q\n';
  const cRef = ctx.register(ctx.flateStream(content));
  page.node.set(PDFName.of('Contents'), cRef);

  const src = await doc.save();
  const conv = new PDFConverter();
  conv.updateColorConfig({ bgHex: '#14140f', textHex: '#eee', objHex: '#48a', objMode: 'adapt', objSaturation: 1, objBorderBrightness: 0.8 });
  const r = await conv.convert(src, { engine: 'stream_remap' });

  eq(r.stats.streamsFailed, 0, 'no failures');
  eq(r.stats.colorOpsRemapped, 3, 'ICC RGB + ICC Gray + Separation remapped (3)');
  eq(r.stats.colorOpsSkipped, 2, 'Indexed + DeviceN(multi) scn skipped (2)');

  const out = (await pageContentStrings(r.pdfBytes))[0];
  ok(/\/CsIdx cs 1 scn/.test(out), 'Indexed scn left byte-identical (1 scn)');
  ok(/\/CsDN cs 0\.5 0\.5 scn/.test(out), 'multi-colorant DeviceN scn left byte-identical');
  ok(!/0\.1 0\.3 0\.75 scn/.test(out), 'ICC RGB scn was rewritten');
  ok(!/\/CsSep cs 0\.8 scn/.test(out), 'Separation scn was rewritten (resolved via its tint function)');

  const sb = skeleton(content);
  const sa = skeleton(out).slice(-sb.length);
  eq(JSON.stringify(sa), JSON.stringify(sb), 'non-colour skeleton identical');

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
