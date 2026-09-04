/**
 * stream-parser.js
 * PDF content-stream tokenizer + colour-operator remapper.
 *
 * Operates on raw (decoded) content-stream BYTES so binary data inside string
 * operands and inline images is never corrupted. Edits are applied as byte
 * splices over the original buffer, so every non-colour byte is preserved
 * exactly.
 *
 * Handles: ( ) literal strings, < > hex strings, << >> dicts, BI..ID..EI inline
 * images (passed through untouched), % comments, the q/Q graphics-state stack,
 * BT/ET text tracking, cs/CS colour-space selection, and the colour operators
 * rg RG g G k K sc scn SC SCN. Images (/Do), shadings (sh) and pattern fills are
 * left alone.
 */

(function (window) {
  'use strict';

  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ( ) < > [ ] { } / %
  const LATIN1 = new TextDecoder('latin1');
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

  const isWS = (c) => WS.has(c);
  const isDelimOrWS = (c) => c === undefined || WS.has(c) || DELIM.has(c);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const StreamParser = {

    /* ---- colour maths ------------------------------------------------ */
    rgbToHsl(r, g, b) {
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      let h, s, l = (max + min) / 2;
      if (max === min) { h = s = 0; }
      else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
      }
      return [h, s, l];
    },

    hslToRgb(h, s, l) {
      if (s === 0) return [l, l, l];
      const f = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
    },

    parseHex(hex) {
      if (!hex) return { r: 0.09, g: 0.09, b: 0.10 };
      const h = hex.replace('#', '');
      return {
        r: parseInt(h.substring(0, 2), 16) / 255,
        g: parseInt(h.substring(2, 4), 16) / 255,
        b: parseInt(h.substring(4, 6), 16) / 255
      };
    },

    /**
     * TEXT colour (inside BT..ET). Neutral (near-greyscale) text is mapped onto
     * the configured text colour regardless of its original lightness; genuine
     * hues (links, coloured headings) keep their hue but are lifted to read on
     * the dark ground. "Neutral" uses CHROMA (max-min), not HSL saturation,
     * which blows up for pale near-white / near-black tints.
     */
    remapTextColor(r, g, b, tc) {
      const [h, s, l] = this.rgbToHsl(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      if (chroma < 0.11) {
        const dark = 1 - l;                                   // 1 for black, 0 for white
        const boost = Math.pow(clamp(dark + 0.25, 0, 1), tc.contrast);
        const k = Math.max(boost, clamp(0.62 + dark * 0.38, 0.62, 1));  // never invisible
        let outR = tc.rgb.r * tc.brightness * k;
        let outG = tc.rgb.g * tc.brightness * k;
        let outB = tc.rgb.b * tc.brightness * k;
        if (tc.warmth) {
          outR = Math.min(1, outR * (1 + tc.warmth * 0.10));
          outB = Math.max(0, outB * (1 - tc.warmth * 0.14));
        }
        return [clamp(outR, 0, 1), clamp(outG, 0, 1), clamp(outB, 0, 1)];
      }

      return this.hslToRgb(h, Math.min(1, s * 1.1), clamp((1 - l) * tc.brightness, 0.55, 0.92));
    },

    /**
     * OBJECT / VECTOR colour (outside BT..ET): rules, table fills, borders,
     * chart shapes, badges.
     */
    remapObjectColor(r, g, b, isStroke, oc, bg) {
      const [h, s, l] = this.rgbToHsl(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      if (chroma < 0.11) {
        if (!isStroke && l > 0.86) {                          // light fill => page/card background
          return [clamp(bg.r + 0.015, 0, 1), clamp(bg.g + 0.015, 0, 1), clamp(bg.b + 0.02, 0, 1)];
        }
        if (!isStroke && l > 0.5) {                           // mid fill => elevated surface (zebra rows)
          const lift = 0.05 + (oc.borderBrightness - 0.8) * 0.06;
          return [clamp(bg.r + lift, 0, 1), clamp(bg.g + lift, 0, 1), clamp(bg.b + lift + 0.01, 0, 1)];
        }
        const v = clamp(0.22 + (1 - l) * oc.borderBrightness * 0.5, 0.14, 0.82);  // rules, dark shapes
        return [v, v, v];
      }

      if (oc.mode === 'tint' || oc.mode === 'custom') return [oc.rgb.r, oc.rgb.g, oc.rgb.b];
      return this.hslToRgb(h, clamp(s * oc.saturation, 0, 1), clamp(1 - l, 0.32, 0.86));
    },

    /* ---- tokeniser -------------------------------------------------- */
    _tokenize(buf) {
      const toks = [];
      const n = buf.length;
      let i = 0;

      while (i < n) {
        const c = buf[i];
        if (isWS(c)) { i++; continue; }
        if (c === 37) { while (i < n && buf[i] !== 10 && buf[i] !== 13) i++; continue; }  // % comment

        const start = i;

        if (c === 47) {                                       // /Name
          i++;
          while (i < n && !isDelimOrWS(buf[i])) i++;
          toks.push({ t: 'name', s: start, e: i, v: LATIN1.decode(buf.subarray(start + 1, i)) });
          continue;
        }

        if (c === 40) {                                       // ( literal string )
          i++;
          let depth = 1;
          while (i < n && depth > 0) {
            const d = buf[i];
            if (d === 92) { i += 2; continue; }               // backslash escape
            if (d === 40) depth++;
            else if (d === 41) depth--;
            i++;
          }
          toks.push({ t: 'skip', s: start, e: i });
          continue;
        }

        if (c === 60) {                                       // << dict-open  or  <hex string>
          if (buf[i + 1] === 60) { toks.push({ t: 'skip', s: start, e: i + 2 }); i += 2; continue; }
          i++;
          while (i < n && buf[i] !== 62) i++;
          i++;
          toks.push({ t: 'skip', s: start, e: i });
          continue;
        }
        if (c === 62) { if (buf[i + 1] === 62) i += 2; else i++; toks.push({ t: 'skip', s: start, e: i }); continue; }
        if (c === 91 || c === 93 || c === 123 || c === 125) { i++; toks.push({ t: 'skip', s: start, e: i }); continue; }

        // bare token: number or operator keyword
        i++;
        while (i < n && !isDelimOrWS(buf[i])) i++;
        const raw = LATIN1.decode(buf.subarray(start, i));

        if (NUM_RE.test(raw)) { toks.push({ t: 'num', s: start, e: i, v: parseFloat(raw) }); continue; }

        if (raw === 'BI') {                                   // inline image: consume BI..ID<binary>EI verbatim
          let j = i;
          while (j < n - 1) {                                 // advance to the ID marker
            if ((j === 0 || isDelimOrWS(buf[j - 1])) && buf[j] === 73 && buf[j + 1] === 68 &&
                (j + 2 >= n || isDelimOrWS(buf[j + 2]))) { j += 3; break; }
            j++;
          }
          while (j < n - 1) {                                 // advance past the binary blob to EI
            if (isWS(buf[j - 1]) && buf[j] === 69 && buf[j + 1] === 73 &&
                (j + 2 >= n || isDelimOrWS(buf[j + 2]))) { j += 2; break; }
            j++;
          }
          i = Math.min(n, j);
          toks.push({ t: 'op', s: start, e: i, v: 'INLINE_IMAGE' });
          continue;
        }

        toks.push({ t: 'op', s: start, e: i, v: raw });
      }
      return toks;
    },

    /** name -> 'gray' | 'rgb' | 'cmyk' | 'pattern' | 'skip' | 'other' */
    _resolveCS(name, csMap) {
      switch (name) {
        case 'DeviceGray': case 'CalGray': case 'G': return 'gray';
        case 'DeviceRGB': case 'CalRGB': case 'RGB': return 'rgb';
        case 'DeviceCMYK': case 'CMYK': return 'cmyk';
        case 'Pattern': return 'pattern';
        default: return csMap[name] || 'other';               // classified by the converter
      }
    },

    _cmykToRgb(c, m, y, k) {
      return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
    },

    _fmt(v) {
      const s = clamp(v, 0, 1).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      return s === '' || s === '-0' ? '0' : s;
    },

    _bytes(str) {
      const out = new Uint8Array(str.length);
      for (let k = 0; k < str.length; k++) out[k] = str.charCodeAt(k) & 0xff;
      return out;
    },

    /* ---- main entry: bytes in, bytes out --------------------------- */
    transformStreamBytes(buf, config) {
      const bg = config.bgRgb || this.parseHex(config.bgHex || '#18181b');
      const tc = {
        rgb: config.textRgb || this.parseHex(config.textHex || '#f4f4f5'),
        brightness: config.textBrightness != null ? config.textBrightness : 1,
        contrast: config.textContrast != null ? config.textContrast : 1,
        warmth: config.textWarmth || 0
      };
      const oc = {
        rgb: config.objRgb || this.parseHex(config.objHex || '#38bdf8'),
        saturation: config.objSaturation != null ? config.objSaturation : 1,
        borderBrightness: config.objBorderBrightness != null ? config.objBorderBrightness : 0.8,
        mode: config.objMode || 'adapt'
      };
      const csMap = config.colorSpaces || {};

      const toks = this._tokenize(buf);
      const edits = [];
      const stats = { remapped: 0, skipped: 0 };

      let inText = 0;
      let fillCS = 'gray', strokeCS = 'gray';
      const gsStack = [];
      let operands = [];
      let curOp = null;

      const takeColor = (op) => {
        const stroke = /^[A-Z]/.test(op);
        const lower = op.toLowerCase();
        const cs = stroke ? strokeCS : fillCS;
        const nums = operands.filter((o) => o.t === 'num');
        const vals = nums.map((o) => o.v);
        let rgb = null;
        let consume = vals.length;

        if (lower === 'g' && vals.length >= 1) { const v = vals[vals.length - 1]; rgb = [v, v, v]; consume = 1; }
        else if (lower === 'rg' && vals.length >= 3) { rgb = vals.slice(-3); consume = 3; }
        else if (lower === 'k' && vals.length >= 4) { rgb = this._cmykToRgb(...vals.slice(-4)); consume = 4; }
        else if (lower === 'sc' || lower === 'scn') {
          if (operands.some((o) => o.t === 'name')) { stats.skipped++; return; }   // pattern colour
          if (cs === 'skip') { stats.skipped++; return; }                          // Indexed / Separation / DeviceN / Lab
          if (cs === 'gray' && vals.length >= 1) { const v = vals[vals.length - 1]; rgb = [v, v, v]; }
          else if (cs === 'rgb' && vals.length >= 3) rgb = vals.slice(-3);
          else if (cs === 'cmyk' && vals.length >= 4) rgb = this._cmykToRgb(...vals.slice(-4));
          // unresolved space: only 3- or 4-operand forms are unambiguously RGB/CMYK-shaped
          else if (vals.length === 3) rgb = vals.slice(-3);
          else if (vals.length === 4) rgb = this._cmykToRgb(...vals.slice(-4));
          else { stats.skipped++; return; }
        } else { stats.skipped++; return; }

        const nc = inText > 0
          ? this.remapTextColor(rgb[0], rgb[1], rgb[2], tc)
          : this.remapObjectColor(rgb[0], rgb[1], rgb[2], stroke, oc, bg);

        const first = nums[Math.max(0, nums.length - consume)];
        edits.push({
          s: first ? first.s : curOp.s,
          e: curOp.e,
          bytes: this._bytes(`${this._fmt(nc[0])} ${this._fmt(nc[1])} ${this._fmt(nc[2])} ${stroke ? 'RG' : 'rg'}`)
        });
        stats.remapped++;
      };

      for (const tk of toks) {
        if (tk.t === 'num' || tk.t === 'name') { operands.push(tk); continue; }
        if (tk.t !== 'op') { operands = []; continue; }        // 'skip' tokens reset operand accumulation

        curOp = tk;
        switch (tk.v) {
          case 'q': gsStack.push([fillCS, strokeCS]); break;
          case 'Q': { const s = gsStack.pop(); if (s) { fillCS = s[0]; strokeCS = s[1]; } break; }
          case 'BT': inText++; break;
          case 'ET': inText = Math.max(0, inText - 1); break;
          case 'cs': { const nm = operands.filter((o) => o.t === 'name').pop(); if (nm) fillCS = this._resolveCS(nm.v, csMap); break; }
          case 'CS': { const nm = operands.filter((o) => o.t === 'name').pop(); if (nm) strokeCS = this._resolveCS(nm.v, csMap); break; }
          case 'g': case 'G': case 'rg': case 'RG': case 'k': case 'K':
          case 'sc': case 'scn': case 'SC': case 'SCN': takeColor(tk.v); break;
        }
        operands = [];
      }

      if (!edits.length) return { bytes: buf, stats };

      edits.sort((a, b) => a.s - b.s);
      const parts = [];
      let pos = 0;
      for (const ed of edits) {
        if (ed.s < pos) continue;                              // defensive: never splice overlaps
        parts.push(buf.subarray(pos, ed.s), ed.bytes);
        pos = ed.e;
      }
      parts.push(buf.subarray(pos));

      let total = 0;
      for (const p of parts) total += p.length;
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return { bytes: out, stats };
    }
  };

  window.StreamParser = StreamParser;
})(typeof window !== 'undefined' ? window : this);
