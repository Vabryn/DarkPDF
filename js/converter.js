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

  /**
   * Compile a PDF tint-transform function (Types 0, 2, 3, 4) into a cheap
   * `(t) => number[]` closure. Used ONLY to resolve Separation / single-
   * colorant DeviceN colourspaces into a real RGB-producing function — every
   * other colourspace already has a direct, unambiguous conversion. All the
   * expensive work (decompressing a stream, parsing a PostScript program) is
   * done ONCE here, up front, so the returned closure — which may run once
   * per colour operator in a content stream — is just arithmetic. Any
   * unsupported feature throws immediately (at compile time, not per-call),
   * and the caller falls back to leaving that colourspace untouched.
   */
  function compilePdfFunction(fnObj, resolve, lib) {
    const { PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = lib;
    const fn = resolve(fnObj);
    if (!fn) throw new Error('null function');
    const dict = fn.dict || fn;
    const get = (k) => resolve(dict.get(PDFName.of(k)));
    const asNum = (v) => (v && v.asNumber ? v.asNumber() : Number(v));
    const numArr = (v) => {
      const a = resolve(v);
      if (!(a instanceof PDFArray)) return null;
      const out = [];
      for (let i = 0; i < a.size(); i++) out.push(asNum(resolve(a.get(i))));
      return out;
    };

    const domain = numArr(get('Domain')) || [0, 1];
    const clampToDomain = (t) => Math.min(domain[1], Math.max(domain[0], t));
    const ft = asNum(get('FunctionType'));

    if (ft === 2) {
      const C0 = numArr(get('C0')) || [0];
      const C1 = numArr(get('C1')) || [1];
      const N = asNum(get('N')) || 1;
      return (input) => {
        const t = clampToDomain(input);
        const tp = Math.pow(t, N);
        return C0.map((c0, i) => c0 + tp * ((C1[i] != null ? C1[i] : 1) - c0));
      };
    }

    if (ft === 3) {
      const fns = resolve(get('Functions'));
      const bounds = numArr(get('Bounds')) || [];
      const encode = numArr(get('Encode')) || [];
      if (!(fns instanceof PDFArray)) throw new Error('bad stitching function');
      const subFns = [];
      for (let i = 0; i < fns.size(); i++) subFns.push(compilePdfFunction(fns.get(i), resolve, lib));
      return (input) => {
        const t = clampToDomain(input);
        let k = 0;
        while (k < bounds.length && t >= bounds[k]) k++;
        const lo = k === 0 ? domain[0] : bounds[k - 1];
        const hi = k === bounds.length ? domain[1] : bounds[k];
        const e0 = encode[2 * k] != null ? encode[2 * k] : 0;
        const e1 = encode[2 * k + 1] != null ? encode[2 * k + 1] : 1;
        const te = hi > lo ? e0 + ((t - lo) / (hi - lo)) * (e1 - e0) : e0;
        return subFns[k](te);
      };
    }

    if (ft === 0) {
      if (!(fn instanceof PDFRawStream)) throw new Error('type0 needs a stream');
      const size = numArr(get('Size'));
      const bitsPerSample = asNum(get('BitsPerSample'));
      const range = numArr(get('Range'));
      if (!size || size.length !== 1 || !range || !bitsPerSample) throw new Error('unsupported type0 shape');
      const encode = numArr(get('Encode')) || [0, size[0] - 1];
      const decodeArr = numArr(get('Decode')) || range;
      const nOut = range.length / 2;
      const data = decodePDFRawStream(fn).decode();               // decompressed ONCE
      const maxVal = Math.pow(2, bitsPerSample) - 1;

      const readSample = (sampleIdx, outIdx) => {
        const bitOffset = (sampleIdx * nOut + outIdx) * bitsPerSample;
        if (bitsPerSample === 8) return data[bitOffset / 8];
        if (bitsPerSample === 16) { const o = bitOffset / 8; return (data[o] << 8) | data[o + 1]; }
        let byteOff = Math.floor(bitOffset / 8), bitOff = bitOffset % 8, val = 0, bitsLeft = bitsPerSample;
        while (bitsLeft > 0) {
          const avail = 8 - bitOff, take = Math.min(avail, bitsLeft);
          const chunk = (data[byteOff] >> (avail - take)) & ((1 << take) - 1);
          val = (val << take) | chunk;
          bitsLeft -= take; bitOff += take;
          if (bitOff >= 8) { bitOff = 0; byteOff++; }
        }
        return val;
      };

      return (input) => {
        const t = clampToDomain(input);
        const e = encode[0] + ((t - domain[0]) / (domain[1] - domain[0] || 1)) * (encode[1] - encode[0]);
        const ec = Math.min(size[0] - 1, Math.max(0, e));
        const i0 = Math.floor(ec), i1 = Math.min(size[0] - 1, i0 + 1), frac = ec - i0;
        const out = [];
        for (let o = 0; o < nOut; o++) {
          const s0 = readSample(i0, o) / maxVal, s1 = readSample(i1, o) / maxVal;
          const s = s0 + frac * (s1 - s0);
          out.push(decodeArr[2 * o] + s * (decodeArr[2 * o + 1] - decodeArr[2 * o]));
        }
        return out;
      };
    }

    if (ft === 4) {
      if (!(fn instanceof PDFRawStream)) throw new Error('type4 needs a stream');
      const src = new TextDecoder('latin1').decode(decodePDFRawStream(fn).decode());
      const program = parsePostScriptProgram(src);                // parsed ONCE
      return (input) => runPostScriptProgram(program, [clampToDomain(input)]);
    }

    throw new Error('unsupported function type ' + ft);
  }

  /** Tokenize + parse a Type 4 (PostScript calculator) function body once. */
  function parsePostScriptProgram(src) {
    const toks = src.match(/\{|\}|[^\s{}]+/g) || [];
    let pos = 0;
    const parseBlock = () => {
      if (toks[pos] !== '{') throw new Error('expected {');
      pos++;
      const body = [];
      while (toks[pos] !== '}') {
        if (pos >= toks.length) throw new Error('unterminated block');
        body.push(toks[pos] === '{' ? parseBlock() : toks[pos++]);
      }
      pos++;
      return body;
    };
    return parseBlock();
  }

  /** Run a pre-parsed PostScript calculator program (PDF function Type 4).
   *  No loop construct exists in this grammar (only if/ifelse), so a step
   *  counter is just a defensive belt-and-suspenders cap, not a real guard. */
  function runPostScriptProgram(program, inputs) {
    const stack = inputs.slice();
    let steps = 0;
    const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
    const exec = (body) => {
      for (const tk of body) {
        if (++steps > 20000) throw new Error('step limit exceeded');
        if (Array.isArray(tk)) { stack.push(tk); continue; }
        if (NUM_RE.test(tk)) { stack.push(parseFloat(tk)); continue; }
        switch (tk) {
          case 'add': { const b = stack.pop(), a = stack.pop(); stack.push(a + b); break; }
          case 'sub': { const b = stack.pop(), a = stack.pop(); stack.push(a - b); break; }
          case 'mul': { const b = stack.pop(), a = stack.pop(); stack.push(a * b); break; }
          case 'div': { const b = stack.pop(), a = stack.pop(); stack.push(a / b); break; }
          case 'idiv': { const b = stack.pop(), a = stack.pop(); stack.push((a / b) | 0); break; }
          case 'mod': { const b = stack.pop(), a = stack.pop(); stack.push(a % b); break; }
          case 'neg': stack.push(-stack.pop()); break;
          case 'abs': stack.push(Math.abs(stack.pop())); break;
          case 'sqrt': stack.push(Math.sqrt(stack.pop())); break;
          case 'sin': stack.push(Math.sin(stack.pop() * Math.PI / 180)); break;
          case 'cos': stack.push(Math.cos(stack.pop() * Math.PI / 180)); break;
          case 'atan': { const b = stack.pop(), a = stack.pop(); let d = Math.atan2(a, b) * 180 / Math.PI; if (d < 0) d += 360; stack.push(d); break; }
          case 'exp': { const b = stack.pop(), a = stack.pop(); stack.push(Math.pow(a, b)); break; }
          case 'ln': stack.push(Math.log(stack.pop())); break;
          case 'log': stack.push(Math.log10(stack.pop())); break;
          case 'ceiling': stack.push(Math.ceil(stack.pop())); break;
          case 'floor': stack.push(Math.floor(stack.pop())); break;
          case 'round': stack.push(Math.round(stack.pop())); break;
          case 'truncate': stack.push(Math.trunc(stack.pop())); break;
          case 'cvi': stack.push(stack.pop() | 0); break;
          case 'cvr': break;
          case 'dup': stack.push(stack[stack.length - 1]); break;
          case 'pop': stack.pop(); break;
          case 'exch': { const b = stack.pop(), a = stack.pop(); stack.push(b, a); break; }
          case 'copy': { const n = stack.pop(); const s = stack.slice(stack.length - n); for (const v of s) stack.push(v); break; }
          case 'index': { const n = stack.pop(); stack.push(stack[stack.length - 1 - n]); break; }
          case 'roll': {
            const j = stack.pop(), n = stack.pop();
            if (n > 0) {
              const part = stack.splice(stack.length - n, n);
              const shift = ((j % n) + n) % n;
              stack.push(...part.slice(n - shift).concat(part.slice(0, n - shift)));
            }
            break;
          }
          case 'eq': { const b = stack.pop(), a = stack.pop(); stack.push(a === b); break; }
          case 'ne': { const b = stack.pop(), a = stack.pop(); stack.push(a !== b); break; }
          case 'gt': { const b = stack.pop(), a = stack.pop(); stack.push(a > b); break; }
          case 'ge': { const b = stack.pop(), a = stack.pop(); stack.push(a >= b); break; }
          case 'lt': { const b = stack.pop(), a = stack.pop(); stack.push(a < b); break; }
          case 'le': { const b = stack.pop(), a = stack.pop(); stack.push(a <= b); break; }
          case 'and': { const b = stack.pop(), a = stack.pop(); stack.push(typeof a === 'boolean' ? (a && b) : (a & b)); break; }
          case 'or': { const b = stack.pop(), a = stack.pop(); stack.push(typeof a === 'boolean' ? (a || b) : (a | b)); break; }
          case 'not': { const a = stack.pop(); stack.push(typeof a === 'boolean' ? !a : ~a); break; }
          case 'xor': { const b = stack.pop(), a = stack.pop(); stack.push(typeof a === 'boolean' ? (a !== b) : (a ^ b)); break; }
          case 'bitshift': { const s = stack.pop(), a = stack.pop(); stack.push(s >= 0 ? (a << s) : (a >> -s)); break; }
          case 'true': stack.push(true); break;
          case 'false': stack.push(false); break;
          case 'if': { const proc = stack.pop(), cond = stack.pop(); if (cond) exec(proc); break; }
          case 'ifelse': { const proc2 = stack.pop(), proc1 = stack.pop(), cond = stack.pop(); exec(cond ? proc1 : proc2); break; }
          default: throw new Error('unsupported PostScript op: ' + tk);
        }
      }
    };
    exec(program);
    return stack;
  }

  function hexToRgb(hex) {
    const h = (hex || '#000000').replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16) / 255,
      g: parseInt(h.substring(2, 4), 16) / 255,
      b: parseInt(h.substring(4, 6), 16) / 255
    };
  }

  function cmykToRgb(c, m, y, k) {
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
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

    /** Yield to the event loop so pending render/input work gets a turn
     *  before the next slice of conversion work runs. Measured: on real
     *  Chromium, requestIdleCallback averaged ~52ms per call here (it waits
     *  for genuine idle time, which is scarce with anything animating on the
     *  page) versus ~0-5ms for a plain macrotask yield -- 10x+ worse for
     *  exactly the case this exists to help. A cheap, frequent yield beats a
     *  "correct-sounding" one that's an order of magnitude slower in practice. */
    _yield() {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

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

    /**
     * Same result as convert(), but runs Standard-mode conversion in a Web
     * Worker so a large document's PDFDocument.save() -- unyielding, can't
     * be chunked -- never blocks the main thread. Scanned mode (needs
     * canvas + pdf.js rendering) and environments without Worker support
     * fall back to the normal in-page convert().
     *
     * Calling this again on the same instance CANCELS any still-running
     * worker job outright (worker.terminate(), not a cooperative flag) --
     * a superseded conversion stops immediately instead of burning CPU
     * (and finishing a multi-second save()) for a result nobody will use.
     */
    convertInWorker(pdfBytes, options = {}) {
      const engine = options.engine || this.currentEngine;
      if (engine === 'scanned_canvas' || typeof Worker === 'undefined') {
        return this.convert(pdfBytes, options);
      }

      if (this._worker) {
        try { this._worker.terminate(); } catch (e) {}
        if (this._workerReject) {
          const superseded = new Error('Superseded by a newer conversion.');
          superseded.superseded = true;
          this._workerReject(superseded);
        }
        this._worker = null;
        this._workerReject = null;
      }

      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const onProgress = options.onProgress || (() => {});
      const bytes = pdfBytes instanceof Uint8Array ? pdfBytes.slice(0) : new Uint8Array(pdfBytes);
      const worker = new Worker('js/converter.worker.js');
      this._worker = worker;

      return new Promise((resolve, reject) => {
        this._workerReject = reject;
        const settle = (fn, arg) => {
          try { worker.terminate(); } catch (e) {}
          if (this._worker === worker) { this._worker = null; this._workerReject = null; }
          fn(arg);
        };
        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'progress') { onProgress({ stage: 'processing', percent: msg.percent, message: msg.message }); return; }
          if (msg.type === 'done') {
            settle(resolve, {
              pdfBytes: msg.pdfBytes, pageCount: msg.pageCount, stats: msg.stats || {},
              durationMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
            });
          } else if (msg.type === 'error') {
            settle(reject, new Error(msg.message));
          }
        };
        worker.onerror = (err) => settle(reject, new Error(err.message || 'Conversion worker failed.'));
        worker.postMessage(
          { pdfBytes: bytes, engine, pageRange: options.pageRange, customConfig: this.customConfig },
          [bytes.buffer]
        );
      });
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
      const lib = this._getPDFLib();
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

          // Separation / single-colorant DeviceN: normally left alone (an
          // arbitrary spot ink's true colour isn't guessable from its name),
          // but its tint-transform function IS a real, evaluable formula —
          // resolve it into a concrete RGB-producing function instead of
          // skipping outright. Any unsupported function shape/type falls
          // back to 'skip', same as before.
          if ((fam === '/Separation' || fam === '/DeviceN') && def.size() >= 4) {
            try {
              const names = resolve(def.get(1));
              const nColorants = fam === '/Separation' ? 1 : (names instanceof PDFArray ? names.size() : 0);
              if (nColorants !== 1) return 'skip';             // multi-ink DeviceN: out of scope
              const altSpace = classify(resolve(def.get(2)));
              if (altSpace !== 'gray' && altSpace !== 'rgb' && altSpace !== 'cmyk') return 'skip';
              // compiled ONCE per colourspace (decompress + parse happen here,
              // not per colour operator) and probed so a broken function
              // falls back to 'skip' up front, never mid-stream
              const compiled = compilePdfFunction(def.get(3), resolve, lib);
              compiled(0.5);
              const evaluate = (t) => {
                const out = compiled(t);
                if (altSpace === 'gray') { const v = out[0]; return [v, v, v]; }
                if (altSpace === 'cmyk') return cmykToRgb(out[0], out[1], out[2], out[3]);
                return [out[0], out[1], out[2]];
              };
              return { evaluate };
            } catch (e) { return 'skip'; }
          }
        }
        return 'skip';                                        // Indexed / DeviceN(multi) / Lab / unknown
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
      const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

      // Yield on elapsed time, not a fixed stream count: a slice of work that
      // takes 8ms on a fast desktop can take far longer on a weak device, so
      // a fixed "every N streams" cadence either yields too rarely (janky on
      // slow hardware) or needlessly often (small preview conversions, which
      // finish in a couple of ms, would otherwise pay for one yield anyway).
      // Time-budgeting adapts automatically to whatever the device can do.
      let lastYield = now();
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

        if (now() - lastYield > 8 || idx === entries.length - 1) {
          onProgress({ stage: 'processing', percent: Math.round(10 + ((idx + 1) / Math.max(1, entries.length)) * 70), message: `Remapping colours — stream ${idx + 1} of ${entries.length}...` });
          await this._yield();
          lastYield = now();
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
