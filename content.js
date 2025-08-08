(() => {
  if (window.__glMrProgressInjected) {
    return;
  }
  window.__glMrProgressInjected = true;

  const WIDGET_ID = "gl-mr-progress-root";
  const SHADOW_HOST_ID = "gl-mr-progress-shadow-host";
  const fileStateByKey = new Map();
  let updateThemeScheduled = false;

  const throttle = (fn, waitMs) => {
    let inFlight = false;
    let pending = false;
    return (...args) => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      fn(...args);
      setTimeout(() => {
        inFlight = false;
        if (pending) {
          pending = false;
          fn(...args);
        }
      }, waitMs);
    };
  };

  function clamp01(value) {
    return Math.min(1, Math.max(0, value));
  }

  function parseCssColor(colorString) {
    if (!colorString) return null;
    const s = colorString.trim();
    // rgb or rgba
    const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/i);
    if (rgbMatch) {
      const [r, g, b, a] = rgbMatch[1]
        .split(",")
        .map((v) => v.trim())
        .map((v, idx) => (idx === 3 ? parseFloat(v) : parseInt(v, 10)));
      return {
        r: r || 0,
        g: g || 0,
        b: b || 0,
        a: a == null || Number.isNaN(a) ? 1 : a,
      };
    }
    // hex #rgb, #rgba, #rrggbb, #rrggbbaa
    const hexMatch = s.match(/^#([0-9a-f]{3,8})$/i);
    if (hexMatch) {
      const h = hexMatch[1];
      if (h.length === 3 || h.length === 4) {
        const r = parseInt(h[0] + h[0], 16);
        const g = parseInt(h[1] + h[1], 16);
        const b = parseInt(h[2] + h[2], 16);
        const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
        return { r, g, b, a };
      }
      if (h.length === 6 || h.length === 8) {
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
        return { r, g, b, a };
      }
    }
    return null;
  }

  function toRgbaString(c, alphaOverride) {
    if (!c) return "rgba(17,17,17,0.75)";
    const a = alphaOverride != null ? alphaOverride : c.a;
    return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(
      c.b
    )}, ${clamp01(a)})`;
  }

  function relativeLuminance(c) {
    const srgb = [c.r, c.g, c.b].map((v) => v / 255);
    const lin = srgb.map((v) =>
      v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
    );
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function mixColors(c1, c2, ratio) {
    const t = clamp01(ratio == null ? 0.5 : ratio);
    return {
      r: c1.r * (1 - t) + c2.r * t,
      g: c1.g * (1 - t) + c2.g * t,
      b: c1.b * (1 - t) + c2.b * t,
      a: c1.a * (1 - t) + c2.a * t,
    };
  }

  function lighten(c, amount) {
    return mixColors(c, { r: 255, g: 255, b: 255, a: c.a }, amount);
  }

  function darken(c, amount) {
    return mixColors(c, { r: 0, g: 0, b: 0, a: c.a }, amount);
  }

  function createShadowUi() {
    let host = document.getElementById(SHADOW_HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = SHADOW_HOST_ID;
      host.style.all = "initial";
      host.style.position = "fixed";
      host.style.top = "16px";
      host.style.right = "16px";
      host.style.zIndex = "999999";
      host.style.display = "none";
      const parent = document.body || document.documentElement;
      parent.appendChild(host);
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

    let root = shadow.getElementById(WIDGET_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = WIDGET_ID;
      shadow.appendChild(root);
    }

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .container {
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
        background: var(--glmr-bg, rgba(17,17,17,0.75));
        backdrop-filter: saturate(130%) blur(6px);
        color: var(--glmr-fg, #f6f7f9);
        border: 1px solid var(--glmr-border, rgba(255,255,255,0.12));
        border-radius: 12px;
        padding: 10px 12px;
        min-width: 220px;
        box-shadow: 0 6px 30px rgba(0,0,0,0.35);
      }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
      .label { font-size: 12px; letter-spacing: 0.02em; opacity: 0.9; }
      .value { font-weight: 600; font-size: 12px; }
      .bar { width: 100%; height: 8px; background: var(--glmr-bar-bg, rgba(255,255,255,0.1)); border-radius: 999px; overflow: hidden; }
      .bar > span { display: block; height: 100%; width: 0%; background: var(--glmr-accent, linear-gradient(90deg, #6ee7b7, #10b981)); transition: width 160ms ease; }
      .footer { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; font-size: 11px; opacity: 0.8; }
      .drag { cursor: move; }
      .muted { opacity: 0.65; }
    `;

    // Ensure we only ever keep one style element
    const existingStyles = shadow.querySelectorAll("style");
    existingStyles.forEach((s) => s.remove());
    shadow.appendChild(style);

    root.innerHTML = `
      <div class="container drag" title="GitLab MR Review Progress">
        <div class="row">
          <div class="label">Reviewed</div>
          <div class="value" id="gl-mr-progress-counts">0 / 0 (0%)</div>
        </div>
        <div class="bar"><span id="gl-mr-progress-bar"></span></div>
        <div class="footer">
          <div id="gl-mr-progress-remaining" class="muted">0 remaining</div>
          <div id="gl-mr-progress-source" class="muted">DOM</div>
        </div>
      </div>
    `;

    makeDraggable(shadow.querySelector(".container"));

    return {
      host,
      shadow,
      countsEl: shadow.getElementById("gl-mr-progress-counts"),
      barEl: shadow.getElementById("gl-mr-progress-bar"),
      remainingEl: shadow.getElementById("gl-mr-progress-remaining"),
      sourceEl: shadow.getElementById("gl-mr-progress-source"),
    };
  }

  function makeDraggable(el) {
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    const down = (e) => {
      dragging = true;
      const host = el.getRootNode().host;
      const rect = host.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const host = el.getRootNode().host;
      host.style.left = `${Math.max(0, startLeft + dx)}px`;
      host.style.top = `${Math.max(0, startTop + dy)}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      host.style.position = "fixed";
    };
    const up = () => {
      dragging = false;
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };

    el.addEventListener("mousedown", down);
  }

  function isOnDiffsTab() {
    try {
      const path = location.pathname || "";
      const search = location.search || "";
      const hash = location.hash || "";
      if (/\/merge_requests\/[0-9]+\/diffs(?:$|[/?#])/.test(path)) return true;
      if (/\/\-\/merge_requests\/[0-9]+\/diffs(?:$|[/?#])/.test(path))
        return true;
      if (/[?&]tab=diffs(?:&|$)/.test(search)) return true;
      if (/^#diffs/.test(hash)) return true;
    } catch (_) {}
    return false;
  }

  function textToIntOrNull(text) {
    if (!text) return null;
    const match = String(text).match(/(\d{1,6})/);
    if (!match) return null;
    const n = parseInt(match[1], 10);
    return Number.isFinite(n) ? n : null;
  }

  function getDeclaredTotalFromTabs() {
    const containers = [
      '[data-testid="diffs-tab"]',
      '[data-qa-selector="diffs_tab"]',
      '.gl-tabs a[aria-controls*="diffs"], .nav-links a[href$="/diffs"], a[href*="/merge_requests/"][href$="/diffs"], a[href*="/-/merge_requests/"][href$="/diffs"]',
    ];
    for (const sel of containers) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const badge = el.querySelector(
          ".gl-tab-counter-badge, .badge, .badge-counter, .counter"
        );
        const val = textToIntOrNull(badge ? badge.textContent : el.textContent);
        if (val != null && val > 0) return val;
      }
    }
    return null;
  }

  function getDiffFileContainers() {
    const selectors = [
      '[data-testid="diff-file"]',
      ".diff-file",
      ".file-holder",
      "li.file",
      ".file",
    ];
    const all = selectors.flatMap((sel) =>
      Array.from(document.querySelectorAll(sel))
    );
    const seen = new Set();
    const unique = [];
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      if (!seen.has(el)) {
        seen.add(el);
        unique.push(el);
      }
    }
    return unique;
  }

  function getFileKeyFromElement(el) {
    if (!el) return null;
    const attrNames = [
      "data-path",
      "data-blob-path",
      "data-file-path",
      "data-filename",
    ];
    for (const name of attrNames) {
      const v = el.getAttribute && el.getAttribute(name);
      if (v) return v;
    }
    const dataPathHolder =
      el.querySelector &&
      el.querySelector(
        "[data-path], [data-blob-path], [data-file-path], [data-filename]"
      );
    if (dataPathHolder) {
      for (const name of attrNames) {
        const v = dataPathHolder.getAttribute(name);
        if (v) return v;
      }
    }
    const fileNameEl =
      el.querySelector &&
      el.querySelector(
        '[data-testid="file-title"], .file-title, .file-header, .file'
      );
    const text =
      (fileNameEl || el).getAttribute &&
      (fileNameEl || el).getAttribute("title");
    if (text) return text.trim();
    const text2 = (fileNameEl || el).textContent;
    if (text2) return text2.trim();
    return null;
  }

  function harvestFromFileTree() {
    const selectors = [
      '[data-testid="file-tree"] li',
      ".file-tree li",
      ".file-tree-row",
    ];
    const items = selectors.flatMap((sel) =>
      Array.from(document.querySelectorAll(sel))
    );
    const entries = [];
    for (const item of items) {
      const key = getFileKeyFromElement(item);
      if (!key) continue;
      const viewed =
        item.classList.contains("is-viewed") ||
        item.classList.contains("viewed") ||
        item.getAttribute("data-viewed") === "true" ||
        !!(
          item.querySelector &&
          item.querySelector(
            'input[type="checkbox"]:checked, input[type="checkbox"][aria-checked="true"], .viewed, [aria-label*="Viewed"]'
          )
        );
      entries.push([key, viewed]);
    }
    return entries;
  }

  function computeProgress() {
    // Merge states from file tree (likely complete) and visible diff containers
    const treeEntries = harvestFromFileTree();
    for (const [key, viewed] of treeEntries) {
      if (!fileStateByKey.has(key)) fileStateByKey.set(key, viewed);
      else if (viewed) fileStateByKey.set(key, true);
    }
    const containers = getDiffFileContainers();
    for (const c of containers) {
      const key =
        getFileKeyFromElement(c) ||
        `__idx_${Math.random().toString(36).slice(2)}`;
      const viewed =
        c.classList.contains("is-viewed") ||
        c.classList.contains("viewed") ||
        c.getAttribute("data-viewed") === "true" ||
        !!c.querySelector(
          'input[type="checkbox"]:checked, input[type="checkbox"][aria-checked="true"]'
        );
      if (!fileStateByKey.has(key)) fileStateByKey.set(key, viewed);
      else if (viewed) fileStateByKey.set(key, true);
    }

    const declaredTotal = getDeclaredTotalFromTabs();
    const total =
      declaredTotal != null
        ? declaredTotal
        : Math.max(fileStateByKey.size, containers.length);
    let viewed = 0;
    for (const v of fileStateByKey.values()) if (v) viewed += 1;
    return { total, viewed };
  }

  let ui = createShadowUi();

  function ensureUiMounted() {
    try {
      const existing = document.getElementById(SHADOW_HOST_ID);
      if (!existing) {
        ui = createShadowUi();
      }
    } catch (_) {}
  }

  function updateThemeVariables() {
    if (updateThemeScheduled) return;
    updateThemeScheduled = true;
    setTimeout(() => {
      updateThemeScheduled = false;
      try {
        const root = document.documentElement;
        const cs = getComputedStyle(root);
        // Try GitLab CSS variables first
        const bgVar =
          cs.getPropertyValue("--gl-background-color-default") ||
          cs.getPropertyValue("--color-bg-default") ||
          cs.getPropertyValue("--gl-body-bg");
        const fgVar =
          cs.getPropertyValue("--gl-text-color-default") ||
          cs.getPropertyValue("--color-fg-default") ||
          cs.getPropertyValue("--gl-body-color");
        const accentVar =
          cs.getPropertyValue("--gl-theme-accent") ||
          cs.getPropertyValue("--brand-primary") ||
          cs.getPropertyValue("--color-accent-fg");

        const pageBg =
          parseCssColor(bgVar) ||
          parseCssColor(cs.backgroundColor) ||
          parseCssColor("rgb(17,17,17)");
        const pageFg =
          parseCssColor(fgVar) ||
          parseCssColor(cs.color) ||
          parseCssColor("rgb(246,247,249)");
        const accent =
          parseCssColor(accentVar) || parseCssColor("rgb(16,185,129)");

        const bg = toRgbaString(darken(pageBg, 0.2), 0.75);
        const fg = toRgbaString(pageFg, 0.95);
        const border = toRgbaString(lighten(pageFg, 0.4), 0.18);
        const barBg = toRgbaString(pageFg, 0.15);
        const accentStart = toRgbaString(lighten(accent, 0.35), 1);
        const accentEnd = toRgbaString(accent, 1);
        const accentCss = `linear-gradient(90deg, ${accentStart}, ${accentEnd})`;

        const styleEl = ui.shadow.querySelector("style");
        if (
          styleEl &&
          styleEl.sheet &&
          styleEl.sheet.cssRules &&
          styleEl.sheet.cssRules.length
        ) {
          const hostEl = ui.shadow.host;
          hostEl.style.setProperty("--glmr-bg", bg);
          hostEl.style.setProperty("--glmr-fg", fg);
          hostEl.style.setProperty("--glmr-border", border);
          hostEl.style.setProperty("--glmr-bar-bg", barBg);
          hostEl.style.setProperty("--glmr-accent", accentCss);
        }
      } catch (_) {}
    }, 0);
  }

  const updateUi = throttle(() => {
    const onDiffs = isOnDiffsTab();
    if (ui.host) ui.host.style.display = onDiffs ? "block" : "none";
    if (!onDiffs) return;
    updateThemeVariables();
    const { total, viewed } = computeProgress();
    const percent = total > 0 ? Math.round((viewed / total) * 100) : 0;
    if (ui.countsEl)
      ui.countsEl.textContent = `${viewed} / ${total} (${percent}%)`;
    if (ui.barEl) ui.barEl.style.width = `${percent}%`;
    if (ui.remainingEl)
      ui.remainingEl.textContent = `${Math.max(0, total - viewed)} remaining`;
    if (ui.sourceEl)
      ui.sourceEl.textContent =
        getDeclaredTotalFromTabs() != null ? "Tabs+DOM" : "DOM";
  }, 120);

  function bindLiveUpdates() {
    // Respond to checkbox changes
    document.addEventListener(
      "change",
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.type !== "checkbox") return;
        updateUi();
      },
      true
    );

    // Observe DOM mutations within the diffs area
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (
          m.type === "childList" &&
          (m.addedNodes.length || m.removedNodes.length)
        ) {
          updateUi();
          continue;
        }
        if (m.type === "attributes") {
          const name = m.attributeName || "";
          if (
            name === "checked" ||
            name === "aria-checked" ||
            name === "class" ||
            name === "data-viewed"
          ) {
            updateUi();
            continue;
          }
        }
      }
    });

    // Try to find a stable diffs container; fallback to body
    const diffsContainer =
      document.querySelector('[data-testid="diffs-container"]') ||
      document.querySelector("#diffs, .merge-request, .content-wrapper, body");

    try {
      observer.observe(diffsContainer || document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["checked", "aria-checked", "class", "data-viewed"],
      });
    } catch (_) {}

    // As a safety net, recalc periodically in case of virtualized lists
    const interval = setInterval(updateUi, 2000);

    // Recompute theme on color scheme or variable changes
    const themeObserver = new MutationObserver(() => updateThemeVariables());
    try {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["style", "class"],
      });
    } catch (_) {}

    // Recompute on history navigation within SPA
    ["pushState", "replaceState"].forEach((method) => {
      const orig = history[method];
      if (typeof orig === "function") {
        history[method] = function (...args) {
          const ret = orig.apply(this, args);
          setTimeout(updateUi, 50);
          return ret;
        };
      }
    });

    window.addEventListener("popstate", () => setTimeout(updateUi, 50));

    // Initial draw (allow MR SPA content to mount)
    setTimeout(updateUi, 50);
    setTimeout(updateUi, 400);

    // Keep UI alive in case the page removes it
    const keepAlive = setInterval(() => {
      ensureUiMounted();
      updateUi();
    }, 1500);

    // Cleanup when the page is unloaded (navigation away)
    window.addEventListener("pagehide", () => {
      clearInterval(interval);
      try {
        themeObserver.disconnect();
      } catch (_) {}
      clearInterval(keepAlive);
    });
  }

  bindLiveUpdates();
})();
