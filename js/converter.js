/**
 * converter.js
 * Core PDF light-to-dark transformation engine.
 *
 * Two modes:
 *   - STANDARD (stream remap) never rasterizes. It edits ONLY the numeric
 *     operands of colour operators inside content streams; every other byte —
 *     text, fonts, links, bookmarks, form fields, metadata, structure tree,
 *     image XObjects — is preserved exactly.
 *   - SCANNED is explicitly lossy: it re-renders each page to an inverted
 *     image. Use it only for image-only scans, where there are no colour
 *     operators to remap.
 *
 * Chunked async processing keeps the UI responsive on 100-500+ page files.
 */

(function (window) {
  'use strict';

  // Only the palette hexes are stored; bg/text/obj RGB and the per-channel
  // inverse (used by the scanned re-inverter) are derived — see normalizeTheme.
  const THEME_HEX = {
    slate:   { name: 'Modern Slate',   bg: '#18181b', text: '#f4f4f5', obj: '#38bdf8' },
    oled:    { name: 'Midnight OLED',  bg: '#000000', text: '#ffffff', obj: '#60a5fa' },
    espresso:{ name: 'Warm Espresso',  bg: '#1c1815', text: '#f5ebd9', obj: '#fbbf24' }
  };

  const SKIP_STREAM_KEYS = new Set(['Filter', 'DecodeParms', 'DP', 'Length', 'F', 'FFilter', 'FDecodeParms']);

  function hexToRgb(hex) {
    const h = (hex || '#000000').replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16) / 255,
      g: parseInt(h.substring(2, 4), 16) / 255,
      b: parseInt(h.substring(4, 6), 16) / 255
    };
  }

  function normalizeTheme(id, name, bgHex, textHex, objHex) {
    const bg = hexToRgb(bgHex), text = hexToRgb(textHex), obj = hexToRgb(objHex);
    return {
      id, name, bgHex, textHex, objHex, bg, text, obj,
      invR: Math.min(1, Math.max(0, 1 - bg.r)),
      invG: Math.min(1, Math.max(0, 1 - bg.g)),
      invB: Math.min(1, Math.max(0, 1 - bg.b))
    };
  }

  class PDFConverter {
    constructor() {
      this.currentEngine = 'stream_remap';
      this.customConfig = {
        bgHex: '#18181b', textHex: '#f4f4f5', textBrightness: 1, textContrast: 1, textWarmth: 0,
        objHex: '#38bdf8', objSaturation: 1, objBorderBrightness: 0.8, objMode: 'adapt'
      };
      this.setTheme('slate');
    }

    setTheme(themeId) {
      const t = THEME_HEX[themeId];
      if (!t) return;
      this.currentTheme = normalizeTheme(themeId, t.name, t.bg, t.text, t.obj);
      this.customConfig.bgHex = t.bg;
      this.customConfig.textHex = t.text;
      this.customConfig.objHex = t.obj;
    }

    /** config.bgHex is the already-composed background (base hue + lightness + warmth). */
    updateColorConfig(config) {
      Object.assign(this.customConfig, config);
      const c = this.customConfig;
      this.currentTheme = normalizeTheme('custom', 'Custom Palette', c.bgHex, c.textHex, c.objHex || '#38bdf8');
    }

    _yield() { return new Promise((r) => setTimeout(r, 0)); }

    _getPDFLib() {
      const lib = window.PDFLib || (typeof PDFLib !== 'undefined' ? PDFLib : null);
      if (!lib) throw new Error('pdf-lib is not loaded (js/vendor/pdf-lib.min.js).');
      return lib;
    }

    async convert(pdfBytes, options = {}) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const engine = options.engine || this.currentEngine;
      const onProgress = options.onProgress || (() => {});
      onProgress({ stage: 'loading', percent: 5, message: 'Parsing PDF structure...' });

      // work on a private copy — pdf-lib / pdf.js may detach the input buffer
      const bytes = pdfBytes instanceof Uint8Array ? pdfBytes.slice(0) : new Uint8Array(pdfBytes);

      let res;
      if (engine === 'scanned_canvas') res = await this._convertScannedCanvas(bytes, onProgress, options);
      else res = await this._convertStreamRemap(bytes, onProgress, options);   // 'stream_remap' (default)

      onProgress({ stage: 'complete', percent: 100, message: 'Conversion complete.' });
      return {
        pdfBytes: res.pdfBytes,
        pageCount: res.pageCount,
        stats: res.stats || {},
        durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
      };
    }

    /* ============ STANDARD — content-stream colour remap (lossless) ======== */
    async _convertStreamRemap(pdfBytes, onProgress, options) {
      const { PDFDocument, PDFName, PDFRef, PDFArray, PDFDict, PDFRawStream, PDFNumber, decodePDFRawStream } = this._getPDFLib();
      const pako = window.pako;

      const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
      const ctx = pdfDoc.context;
      const pages = pdfDoc.getPages();
      const pageCount = pages.length;
      const theme = this.currentTheme;
      const c = this.customConfig;
      const inRange = new Set(this._parsePageRange(options.pageRange, pageCount));

      const cfg = {
        bgRgb: theme.bg, textRgb: theme.text, objRgb: theme.obj,
        textBrightness: c.textBrightness, textContrast: c.textContrast, textWarmth: c.textWarmth,
        objSaturation: c.objSaturation, objBorderBrightness: c.objBorderBrightness, objMode: c.objMode
      };

      const resolve = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);

      // ---- 1. collect every content-stream ref reachable from in-range pages,
      //         plus the Resources dict that governs each one
      const contentRefs = new Map();                          // tag -> { ref, resources }
      const visited = new Set();
      const addRef = (ref, resources) => {
        if (ref instanceof PDFRef && !contentRefs.has(ref.tag)) contentRefs.set(ref.tag, { ref, resources });
      };

      const walkResources = (res, depth) => {
        if ((depth || 0) > 48) return;
        res = resolve(res);
        if (!(res instanceof PDFDict)) return;
        for (const container of ['XObject', 'Pattern']) {
          const dict = resolve(res.get(PDFName.of(container)));
          if (!(dict instanceof PDFDict)) continue;
          for (const key of dict.keys()) {
            const ref = dict.get(key);
            const obj = resolve(ref);
            if (!(obj instanceof PDFRawStream) || !(ref instanceof PDFRef) || visited.has(ref.tag)) continue;
            if ((obj.dict.get(PDFName.of('Subtype')) || {}).toString?.() === '/Image') continue;  // never touch images
            visited.add(ref.tag);
            const own = obj.dict.get(PDFName.of('Resources'));
            addRef(ref, own || res);
            walkResources(own, (depth || 0) + 1);
          }
        }
      };

      const inheritedResources = (node) => {
        let cur = node, guard = 0;
        while (cur && guard++ < 64) {
          const r = resolve(cur.get(PDFName.of('Resources')));
          if (r instanceof PDFDict) return r;
          cur = resolve(cur.get(PDFName.of('Parent')));
        }
        return undefined;
      };

      for (let i = 0; i < pages.length; i++) {
        if (!inRange.has(i + 1)) continue;
        const node = pages[i].node;
        const pageRes = node.Resources() || inheritedResources(node);

        const contents = node.get(PDFName.of('Contents'));
        if (contents instanceof PDFRef) addRef(contents, pageRes);
        else if (contents instanceof PDFArray) for (let j = 0; j < contents.size(); j++) addRef(contents.get(j), pageRes);

        walkResources(pageRes, 0);

        const annots = resolve(node.get(PDFName.of('Annots')));
        if (!(annots instanceof PDFArray)) continue;
        for (let a = 0; a < annots.size(); a++) {
          const ap = resolve((resolve(annots.get(a)) || {}).get?.(PDFName.of('AP')));
          if (!(ap instanceof PDFDict)) continue;
          for (const apKey of ap.keys()) {
            const apVal = ap.get(apKey);
            const apObj = resolve(apVal);
            if (apObj instanceof PDFRawStream) {
              addRef(apVal, apObj.dict.get(PDFName.of('Resources')) || pageRes);
              walkResources(apObj.dict.get(PDFName.of('Resources')), 1);
            } else if (apObj instanceof PDFDict) {
              for (const k of apObj.keys()) {
                const sRef = apObj.get(k), sObj = resolve(sRef);
                if (!(sObj instanceof PDFRawStream)) continue;
                addRef(sRef, sObj.dict.get(PDFName.of('Resources')) || pageRes);
                walkResources(sObj.dict.get(PDFName.of('Resources')), 1);
              }
            }
          }
        }
      }

      // ---- colour-space classification, memoised per Resources dict
      const csCache = new Map();
      const classify = (def) => {
        if (def instanceof PDFName) {
          const n = def.toString();
          if (n === '/DeviceGray' || n === '/CalGray' || n === '/G') return 'gray';
          if (n === '/DeviceRGB' || n === '/CalRGB' || n === '/RGB') return 'rgb';
          if (n === '/DeviceCMYK' || n === '/CMYK') return 'cmyk';
          return 'skip';
        }
        if (def instanceof PDFArray && def.size() >= 1) {
          const fam = def.get(0) && def.get(0).toString();
          if (fam === '/ICCBased') {
            const s = resolve(def.get(1));
            const N = s && s.dict ? s.dict.get(PDFName.of('N')) : null;
            const n = N && N.asNumber ? N.asNumber() : (N ? Number(N.toString()) : 3);
            return n === 1 ? 'gray' : n === 4 ? 'cmyk' : 'rgb';
          }
          if (fam === '/CalGray') return 'gray';
          if (fam === '/CalRGB') return 'rgb';
        }
        return 'skip';                                        // Indexed / Separation / DeviceN / Lab / unknown
      };
      const colorSpaceMap = (res) => {
        res = resolve(res);
        if (!(res instanceof PDFDict)) return {};
        if (csCache.has(res)) return csCache.get(res);
        const map = {};
        const csDict = resolve(res.get(PDFName.of('ColorSpace')));
        if (csDict instanceof PDFDict) {
          for (const key of csDict.keys()) map[key.toString().replace(/^\//, '')] = classify(resolve(csDict.get(key)));
        }
        csCache.set(res, map);
        return map;
      };

      // ---- 2. rewrite each unique stream
      const stat = { engine: 'stream_remap', streamsProcessed: 0, streamsChanged: 0, colorOpsRemapped: 0, colorOpsSkipped: 0, streamsFailed: 0 };
      const entries = Array.from(contentRefs.values());

      for (let idx = 0; idx < entries.length; idx++) {
        const { ref, resources } = entries[idx];
        const stream = ctx.lookup(ref);
        if (!(stream instanceof PDFRawStream)) continue;

        let raw;
        try { raw = decodePDFRawStream(stream).decode(); }
        catch (e) { stat.streamsFailed++; continue; }         // undecodable filter chain — leave as-is

        stat.streamsProcessed++;
        let result;
        try { result = window.StreamParser.transformStreamBytes(raw, { ...cfg, colorSpaces: colorSpaceMap(resources) }); }
        catch (e) { stat.streamsFailed++; continue; }
        stat.colorOpsRemapped += result.stats.remapped;
        stat.colorOpsSkipped += result.stats.skipped;
        if (result.stats.remapped === 0) continue;

        const newDict = ctx.obj({});
        for (const [k, v] of stream.dict.entries()) {
          if (!SKIP_STREAM_KEYS.has(k.toString().slice(1))) newDict.set(k, v);
        }
        let payload = result.bytes;
        if (pako) {
          try { payload = pako.deflate(result.bytes); newDict.set(PDFName.of('Filter'), PDFName.of('FlateDecode')); }
          catch (e) { payload = result.bytes; }
        }
        newDict.set(PDFName.of('Length'), PDFNumber.of(payload.length));
        ctx.assign(ref, PDFRawStream.of(newDict, payload));
        stat.streamsChanged++;

        if (idx % 6 === 0 || idx === entries.length - 1) {
          onProgress({ stage: 'processing', percent: Math.round(10 + ((idx + 1) / Math.max(1, entries.length)) * 70), message: `Remapping colours — stream ${idx + 1} of ${entries.length}...` });
          await this._yield();
        }
      }

      // ---- 3. lay a dark ground behind every in-range page
      for (let i = 0; i < pages.length; i++) {
        if (!inRange.has(i + 1)) continue;
        const page = pages[i];
        const { x, y, width, height } = page.getCropBox();
        const bgRef = ctx.register(ctx.flateStream(
          `q\n${theme.bg.r.toFixed(4)} ${theme.bg.g.toFixed(4)} ${theme.bg.b.toFixed(4)} rg\n${x} ${y} ${width} ${height} re\nf\nQ\n`
        ));
        this._prependContent(ctx, page, bgRef, PDFName, PDFRef, PDFArray);
      }

      onProgress({ stage: 'saving', percent: 95, message: 'Encoding output PDF...' });
      await this._yield();
      return { pdfBytes: await pdfDoc.save(), pageCount, stats: stat };
    }

    /* ============ SCANNED — page raster inverter (LOSSY) ================== */
    async _convertScannedCanvas(pdfBytes, onProgress, options) {
      if (!window.pdfjsLib) throw new Error('pdf.js is required for Scanned mode.');
      const { PDFDocument } = this._getPDFLib();

      const pdf = await window.pdfjsLib.getDocument({
        data: pdfBytes instanceof Uint8Array ? pdfBytes.slice(0) : new Uint8Array(pdfBytes),
        useSystemFonts: true, isEvalSupported: false
      }).promise;
      const pageCount = pdf.numPages;
      const outputDoc = await PDFDocument.create();
      const inRange = new Set(this._parsePageRange(options.pageRange, pageCount));
      const theme = this.currentTheme;
      const CONTRAST = 1.15;
      const factor = (259 * (CONTRAST * 255 + 255)) / (255 * (259 - CONTRAST * 255));

      for (let i = 1; i <= pageCount; i++) {
        if (!inRange.has(i)) continue;
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const cctx = canvas.getContext('2d');
        await page.render({ canvasContext: cctx, viewport }).promise;

        const img = cctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        for (let j = 0; j < d.length; j += 4) {
          let r = factor * ((255 - d[j]) - 128) + 128;
          let g = factor * ((255 - d[j + 1]) - 128) + 128;
          let b = factor * ((255 - d[j + 2]) - 128) + 128;
          if (theme.id !== 'oled') { r *= theme.invR; g *= theme.invG; b *= theme.invB; }
          d[j] = Math.max(0, Math.min(255, r));
          d[j + 1] = Math.max(0, Math.min(255, g));
          d[j + 2] = Math.max(0, Math.min(255, b));
        }
        cctx.putImageData(img, 0, 0);

        const w = page.view[2] - page.view[0], h = page.view[3] - page.view[1];
        const embedded = await outputDoc.embedJpg(canvas.toDataURL('image/jpeg', 0.92));
        outputDoc.addPage([w, h]).drawImage(embedded, { x: 0, y: 0, width: w, height: h });
        canvas.width = canvas.height = 1;

        onProgress({ stage: 'processing', percent: Math.round(15 + (i / pageCount) * 75), message: `Inverting scanned page ${i} of ${pageCount}...` });
        await this._yield();
      }

      onProgress({ stage: 'saving', percent: 95, message: 'Encoding output PDF...' });
      await this._yield();
      return { pdfBytes: await outputDoc.save(), pageCount, stats: { engine: 'scanned_canvas', lossy: true } };
    }

    /* ---- helpers -------------------------------------------------------- */
    _prependContent(ctx, page, ref, PDFName, PDFRef, PDFArray) {
      const key = PDFName.of('Contents');
      const contents = page.node.get(key);
      if (!contents) page.node.set(key, ref);
      else if (contents instanceof PDFRef) page.node.set(key, ctx.obj([ref, contents]));
      else if (contents instanceof PDFArray) contents.insert(0, ref);
    }

    _parsePageRange(rangeStr, totalPages) {
      const all = () => Array.from({ length: totalPages }, (_, i) => i + 1);
      const str = String(rangeStr || '').trim();
      if (!str || str.toLowerCase() === 'all') return all();
      const pages = new Set();
      for (const part of str.split(',')) {
        const t = part.trim();
        if (t.includes('-')) {
          const [a, b] = t.split('-').map((n) => parseInt(n.trim(), 10));
          if (!isNaN(a) && !isNaN(b)) {
            for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(totalPages, Math.max(a, b)); p++) pages.add(p);
          }
        } else {
          const p = parseInt(t, 10);
          if (!isNaN(p) && p >= 1 && p <= totalPages) pages.add(p);
        }
      }
      return pages.size ? Array.from(pages).sort((a, b) => a - b) : all();
    }
  }

  window.PDFConverter = PDFConverter;
})(typeof window !== 'undefined' ? window : this);
