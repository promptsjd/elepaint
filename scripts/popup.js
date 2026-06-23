/**
 * elepaint — all application JavaScript.
 *
 * Organized into named IIFE namespaces that mirror the module file structure.
 * Each namespace is self-contained, has no access to another namespace's
 * internals, and depends only on namespaces declared above it.
 *
 * Dependency order (strictly top-to-bottom, no cycles):
 *   Color   → pure OKLCH math, no deps
 *   Palette → uses Color
 *   State   → no deps
 *   SwatchUI   → uses State (for history); owns swatch DOM
 *   ControlsUI → owns control DOM
 *   Bootstrap  → wires everything; entry point
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  COLOR ENGINE
//  Pure functions — no DOM access, no side effects, fully unit-testable.
//  Mirrors: scripts/color/oklch.js
// ═══════════════════════════════════════════════════════════════════════════

const Color = (() => {

  /**
   * Converts OKLCH to linear-light RGB (pre-gamma).
   * Uses the OKLab intermediate space for perceptual uniformity.
   */
  function oklchToLinearRgb(L, C, H) {
    const h = H * (Math.PI / 180);
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);

    // OKLab → LMS (cube-root space)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    // LMS → linear RGB (Bradford-adapted D65)
    return [
      +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.6956082950 * s,
    ];
  }

  /** Applies sRGB gamma correction to a single linear-light channel [0, 1]. */
  function linearToSrgb(c) {
    const v = Math.max(0, Math.min(1, c));
    return v <= 0.0031308
      ? 12.92 * v
      : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  /** Returns true if the OKLCH triple maps to a representable sRGB color. */
  function inGamut(L, C, H) {
    const [r, g, b] = oklchToLinearRgb(L, C, H);
    const eps = 0.0005;
    return (
      r >= -eps && r <= 1 + eps &&
      g >= -eps && g <= 1 + eps &&
      b >= -eps && b <= 1 + eps
    );
  }

  /**
   * Binary-searches for the largest chroma ≤ C that keeps the color inside
   * sRGB gamut. 28 iterations → precision of ~4×10⁻⁹.
   */
  function clampChroma(L, C, H) {
    if (inGamut(L, C, H)) return C;
    let lo = 0, hi = C;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(L, mid, H)) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** Full pipeline: OKLCH → uppercase hex string (without #). */
  function oklchToHex(L, C, H) {
    const c = clampChroma(L, C, H);
    const [lr, lg, lb] = oklchToLinearRgb(L, c, H);
    const r = Math.round(linearToSrgb(lr) * 255);
    const g = Math.round(linearToSrgb(lg) * 255);
    const b = Math.round(linearToSrgb(lb) * 255);
    return [r, g, b]
      .map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }

  return { oklchToHex };

})();


// ═══════════════════════════════════════════════════════════════════════════
//  PALETTE ENGINE
//  Harmony config + palette generation. Uses Color.
//  Mirrors: scripts/color/palette.js
// ═══════════════════════════════════════════════════════════════════════════

const Palette = (() => {

  const rand    = (min, max) => min + Math.random() * (max - min);
  const wrapHue = h => ((h % 360) + 360) % 360;

  /**
   * Master harmony registry. To add a new harmony: add one entry here.
   * Nothing else in the codebase needs to change — the UI select and
   * subtitle label are both populated from this array at runtime.
   *
   * hueOffsets — [primary, secondary, accent] deltas from a random base hue.
   *
   * The +205 offset in 'complementary' is an intentional aesthetic tweak:
   * a pure 180° opposite can look flat in pastel ranges, so the accent hue
   * is nudged 25° to add visual interest without breaking the relationship.
   */
  const HARMONIES = [
    { id: 'complementary',       label: 'Complementary',       hueOffsets: [0, 180, 205] },
    { id: 'triadic',             label: 'Triadic',             hueOffsets: [0, 120, 240] },
    { id: 'split-complementary', label: 'Split-Complementary', hueOffsets: [0, 150, 210] },
    { id: 'analogous',           label: 'Analogous',           hueOffsets: [0,  28,  58] },
    { id: 'monochromatic',       label: 'Monochromatic',       hueOffsets: [0,   0,   0] },
  ];

  /**
   * L (lightness) and C (chroma) ranges per role, per mode.
   *
   * Ranges are non-overlapping by design: minimum L gap between any two roles
   * is ≥ 0.10, so the 60:30:10 roles are always visually distinct regardless
   * of the hue drawn.
   *
   *   primary   → 60%  dominant, lightest tone
   *   secondary → 30%  supporting mid-tone
   *   accent    → 10%  punchy, darkest/most vivid anchor
   */
  const ROLES = {
    multiHue: {
      primary:   { L: [0.82, 0.91], C: [0.03, 0.07] },
      secondary: { L: [0.62, 0.74], C: [0.09, 0.14] },
      accent:    { L: [0.52, 0.65], C: [0.17, 0.25] },
    },
    mono: {
      primary:   { L: [0.85, 0.92], C: [0.02, 0.05] },
      secondary: { L: [0.60, 0.68], C: [0.08, 0.13] },
      accent:    { L: [0.38, 0.50], C: [0.14, 0.22] },
    },
  };

  function getHarmonyById(id) {
    return HARMONIES.find(h => h.id === id) || HARMONIES[0];
  }

  function randomHarmony() {
    return HARMONIES[Math.floor(Math.random() * HARMONIES.length)];
  }

  /**
   * Generates a 3-color palette following the 60:30:10 rule.
   * Returns a plain data object — no DOM dependencies.
   *
   * @returns {{ harmonyId, harmonyLabel, colors: Array<{hex, L}> }}
   */
  function generatePalette(harmony) {
    const base   = Math.random() * 360;
    const isMono = harmony.id === 'monochromatic';
    const roles  = isMono ? ROLES.mono : ROLES.multiHue;
    const hues   = harmony.hueOffsets.map(offset => wrapHue(base + offset));

    const makeColor = (roleName, hue) => {
      const role = roles[roleName];
      const L = rand(role.L[0], role.L[1]);
      const C = rand(role.C[0], role.C[1]);
      return { hex: Color.oklchToHex(L, C, hue), L };
    };

    return {
      harmonyId:    harmony.id,
      harmonyLabel: harmony.label,
      colors: [
        makeColor('primary',   hues[0]),
        makeColor('secondary', hues[1]),
        makeColor('accent',    hues[2]),
      ],
    };
  }

  return { HARMONIES, getHarmonyById, randomHarmony, generatePalette };

})();


// ═══════════════════════════════════════════════════════════════════════════
//  STATE
//  Single source of truth. No DOM access.
//  Mirrors: scripts/state.js
// ═══════════════════════════════════════════════════════════════════════════

const State = (() => {

  const MAX_HISTORY = 20;

  const state = {
    harmonyId: 'random',
    palette:   null,
    history:   [],   // previous palettes, newest first — ready for undo/history UI
  };

  function setHarmony(id) {
    state.harmonyId = id;
  }

  function setPalette(palette) {
    if (state.palette) {
      state.history.unshift(state.palette);
      if (state.history.length > MAX_HISTORY) state.history.pop();
    }
    state.palette = palette;
  }

  return { state, setHarmony, setPalette };

})();


// ═══════════════════════════════════════════════════════════════════════════
//  UI — SWATCHES
//  Renders palette colors into the DOM; handles click-to-copy.
//  Mirrors: scripts/ui/swatches.js
// ═══════════════════════════════════════════════════════════════════════════

const SwatchUI = (() => {

  // L > 0.62 is perceptually "light" — dark text reads comfortably above this.
  // Tuned to the L ranges in Palette ROLES so contrast is always adequate.
  const CONTRAST_THRESHOLD = 0.62;
  const TEXT_ON_LIGHT = 'rgba(0, 0, 0, 0.60)';
  const TEXT_ON_DARK  = 'rgba(255, 255, 255, 0.82)';
  const COPY_RESET_MS = 1100;

  function getSwatchEls() {
    return [0, 1, 2].map(i => document.getElementById('swatch-' + i));
  }

  /** Paints all three swatches to match the given palette. */
  function renderPalette(palette) {
    const swatchEls = getSwatchEls();
    palette.colors.forEach(function(color, i) {
      const el        = swatchEls[i];
      const textColor = color.L > CONTRAST_THRESHOLD ? TEXT_ON_LIGHT : TEXT_ON_DARK;

      el.style.backgroundColor = '#' + color.hex;
      el.dataset.hex = color.hex;

      const hexEl    = el.querySelector('.swatch-hex');
      const copiedEl = el.querySelector('.swatch-copied-msg');

      hexEl.textContent    = '#' + color.hex;
      hexEl.style.color    = textColor;
      copiedEl.style.color = textColor;
    });
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function() {
        fallbackCopy(text);
      });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  /** Attaches click-to-copy listeners to each swatch. */
  function bindSwatchCopyHandlers() {
    getSwatchEls().forEach(function(el) {
      el.addEventListener('click', function() {
        const hex = el.dataset.hex;
        if (!hex) return;
        copyToClipboard(hex);
        el.classList.add('copied');
        setTimeout(function() { el.classList.remove('copied'); }, COPY_RESET_MS);
      });
    });
  }

  return { renderPalette, bindSwatchCopyHandlers };

})();


// ═══════════════════════════════════════════════════════════════════════════
//  UI — CONTROLS
//  Thin event-binding layer. Translates DOM events into callbacks.
//  Zero business logic — callers supply all behavior via callback arguments.
//  Mirrors: scripts/ui/controls.js
// ═══════════════════════════════════════════════════════════════════════════

const ControlsUI = (() => {

  function bindGenerateButton(onGenerate) {
    document.getElementById('generate-btn').addEventListener('click', onGenerate);
  }

  function bindHarmonySelect(onChange) {
    document.getElementById('harmony-select').addEventListener('change', function(e) {
      onChange(e.target.value);
    });
  }

  function bindCloseButton() {
    document.getElementById('close-btn').addEventListener('click', function() {
      window.close();
    });
  }

  function setHarmonyLabel(label) {
    document.getElementById('harmony-name').textContent = label;
  }

  return { bindGenerateButton, bindHarmonySelect, bindCloseButton, setHarmonyLabel };

})();


// ═══════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
//  Entry point — detects environment, wires namespaces, renders first palette.
//  Mirrors: scripts/main.js
// ═══════════════════════════════════════════════════════════════════════════

(function() {

  function isExtensionContext() {
    try { return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  }

  function generate() {
    const harmony = State.state.harmonyId === 'random'
      ? Palette.randomHarmony()
      : Palette.getHarmonyById(State.state.harmonyId);

    const palette = Palette.generatePalette(harmony);
    State.setPalette(palette);
    SwatchUI.renderPalette(palette);
    ControlsUI.setHarmonyLabel(palette.harmonyLabel);
  }

  if (!isExtensionContext()) {
    document.body.classList.add('standalone');
  }

  SwatchUI.bindSwatchCopyHandlers();
  ControlsUI.bindGenerateButton(generate);
  ControlsUI.bindHarmonySelect(function(id) { State.setHarmony(id); generate(); });
  ControlsUI.bindCloseButton();

  generate();

})();
