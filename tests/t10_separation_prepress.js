// TEST 10 — real-world prepress Separation colourspaces (/All, /Black), the
// exact pattern found in a scanned textbook PDF that reported washed-out
// figure lines: our converter used to skip Separation outright, leaving
// axis lines/labels literal black-on-near-black. These are safely
// evaluable (Type2 exponential, Type4 PostScript calculator) and must now
// be resolved and remapped like any other colour.
const { PDFLib, PDFConverter } = require('./_boot.js');
const { pageContentStrings } = require('./lib.js');

(async () => {
  console.log('\n=== TEST 10: /Separation /All + /Black (prepress black inks) ===');
  const { PDFName, PDFString } = PDFLib;

  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ctx = doc.context;

  // /Separation /All /DeviceGray  with a Type2 fn: gray = 1 - t  (verbatim from the report)
  const csAll = ctx.obj(['Separation', 'All', 'DeviceGray',
    ctx.obj({ C0: [1], C1: [0], Domain: [0, 1], FunctionType: 2, N: 1 })]);

  // /Separation /Black /DeviceCMYK  with a Type4 PostScript calculator fn (verbatim)
  const psProgram = new TextEncoder().encode('{0 0 0 4 -1 roll}');
  const blackFnRef = ctx.register(ctx.stream(psProgram, {
    FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1, 0, 1]
  }));
  const csBlack = ctx.obj(['Separation', 'Black', 'DeviceCMYK', blackFnRef]);

  const csDict = ctx.obj({ CsAll: csAll, CsBlack: csBlack });
  const res = page.node.Resources();
  res.set(PDFName.of('ColorSpace'), csDict);

  const content =
    'q\n' +
    '/CsAll CS 0.15 SCN 10 10 m 190 190 l S\n' +      // light-grey axis-line stroke (tint 0.15 -> gray 0.85)
    '/CsBlack cs 1 scn 10 10 80 30 re f\n' +           // solid black fill (tint 1 -> K=1 -> rgb 0,0,0)
    'Q\n';
  const cRef = ctx.register(ctx.flateStream(content));
  page.node.set(PDFName.of('Contents'), cRef);

  const src = await doc.save();
  const conv = new PDFConverter();
  conv.updateColorConfig({ bgHex: '#18181b', textHex: '#f4f4f5', objHex: '#38bdf8', objMode: 'adapt', objSaturation: 1, objBorderBrightness: 0.8 });
  const r = await conv.convert(src, { engine: 'stream_remap' });

  eq(r.stats.streamsFailed, 0, 'no stream failures');
  eq(r.stats.colorOpsRemapped, 2, 'both Separation colour ops resolved and remapped (2)');
  eq(r.stats.colorOpsSkipped, 0, 'neither op fell back to skip');

  const out = (await pageContentStrings(r.pdfBytes))[0];
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const bgLum = lum([0x18 / 255, 0x18 / 255, 0x1b / 255]);

  // scope each match to right after its own "/CsX cs|CS" selector — the page
  // also carries its own dark-ground background rg fill earlier in the stream
  const strokeMatch = out.match(/\/CsAll CS\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+RG/);
  ok(!!strokeMatch, 'the /All light-grey axis line was rewritten to an RG stroke');
  if (strokeMatch) {
    const c = [+strokeMatch[1], +strokeMatch[2], +strokeMatch[3]];
    ok(lum(c) - bgLum > 0.2, `/All stroke (was near-invisible) now clears the contrast floor (lum ${lum(c).toFixed(3)} vs bg ${bgLum.toFixed(3)})`);
  }

  const fillMatch = out.match(/\/CsBlack cs\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
  ok(!!fillMatch, 'the /Black solid fill was rewritten to an rg fill');
  if (fillMatch) {
    const c = [+fillMatch[1], +fillMatch[2], +fillMatch[3]];
    ok(lum(c) > 0.45, `/Black solid fill (pure black ink) stays bold (lum ${lum(c).toFixed(3)})`);
  }

  summary();
})().catch(e => { console.error(e); process.exitCode = 1; });
