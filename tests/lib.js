const { PDFLib } = require('./_boot.js');
const { PDFName, PDFRef, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;

// Decode every page content stream of a doc into one latin1 string per page.
async function pageContentStrings(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const out = [];
  for (const page of doc.getPages()) {
    let c = page.node.get(PDFName.of('Contents'));
    const refs = [];
    if (c instanceof PDFRef) refs.push(c);
    else if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) refs.push(c.get(i));
    let s = '';
    for (const r of refs) {
      const st = ctx.lookup(r);
      if (st instanceof PDFRawStream) s += new TextDecoder('latin1').decode(decodePDFRawStream(st).decode()) + '\n';
    }
    out.push(s);
  }
  return out;
}

// Extract the non-colour "skeleton" of a content stream: every token except
// colour-operator operands/names. Used to prove nothing but colour changed.
function skeleton(streamStr) {
  const COLOR_OPS = new Set(['rg','RG','g','G','k','K','sc','scn','SC','SCN','cs','CS']);
  const toks = streamStr.match(/\(([^\\()]|\\.)*\)|<[0-9A-Fa-f\s]*>|\[|\]|[^\s\[\]]+/g) || [];
  const skel = [];
  let pending = [];
  for (const t of toks) {
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) { pending.push(t); continue; }
    if (/^\/[^\s]+$/.test(t)) { pending.push(t); continue; }
    if (t === '[' || t === ']') { skel.push(...pending, t); pending = []; continue; }
    if (COLOR_OPS.has(t)) { pending = []; continue; }           // drop colour operands+op
    skel.push(...pending, t); pending = [];
  }
  return skel;
}

async function docInfo(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();
  let annots = 0, links = 0, widgets = 0, images = 0;
  for (const p of pages) {
    const a = p.node.get(PDFName.of('Annots'));
    const arr = a instanceof PDFRef ? ctx.lookup(a) : a;
    if (arr instanceof PDFArray) {
      for (let i = 0; i < arr.size(); i++) {
        const an = ctx.lookup(arr.get(i));
        if (!(an instanceof PDFDict)) continue;
        annots++;
        const sub = an.get(PDFName.of('Subtype'));
        if (sub && sub.toString() === '/Link') links++;
        if (sub && sub.toString() === '/Widget') widgets++;
      }
    }
    const res = p.node.Resources ? p.node.Resources() : null;
    const xo = res && res.get(PDFName.of('XObject'));
    const xod = xo instanceof PDFRef ? ctx.lookup(xo) : xo;
    if (xod instanceof PDFDict) {
      for (const k of xod.keys()) {
        const o = ctx.lookup(xod.get(k));
        if (o instanceof PDFRawStream) {
          const st = o.dict.get(PDFName.of('Subtype'));
          if (st && st.toString() === '/Image') images++;
        }
      }
    }
  }
  const cat = ctx.lookup(doc.catalog.get(PDFName.of('Root'))) || doc.catalog;
  const hasOutline = !!doc.catalog.get(PDFName.of('Outlines'));
  const hasAcroForm = !!doc.catalog.get(PDFName.of('AcroForm'));
  const hasStructTree = !!doc.catalog.get(PDFName.of('StructTreeRoot'));
  return { pages: pages.length, annots, links, widgets, images, hasOutline, hasAcroForm, hasStructTree, size: bytes.length };
}

// Collect image XObject stream bytes keyed by ref tag.
async function imageStreamBytes(bytes) {
  const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const ctx = doc.context;
  const map = {};
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const st = obj.dict.get(PDFName.of('Subtype'));
      if (st && st.toString() === '/Image') {
        map[ref.tag] = Buffer.from(obj.getContents()).toString('hex');
      }
    }
  }
  return map;
}

module.exports = { pageContentStrings, skeleton, docInfo, imageStreamBytes };
