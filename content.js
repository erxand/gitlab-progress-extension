(() => {
  if (window.__glMrProgressInjected) {
    return;
  }
  window.__glMrProgressInjected = true;

  const WIDGET_ID = "gl-mr-progress-root";
  const SHADOW_HOST_ID = "gl-mr-progress-shadow-host";
  // Legacy (pre "Rapid Diffs") state, keyed by file path/name harvested from the DOM.
  const fileStateByKey = new Map();
  const fileLinesByKey = new Map();
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
        <div class="section">
          <div class="row">
            <div class="label">Files Viewed</div>
            <div class="value" id="gl-mr-progress-counts">0 / 0 (0%)</div>
          </div>
          <div class="bar"><span id="gl-mr-files-bar"></span></div>
        </div>
        <div class="section" style="margin-top:10px;">
          <div class="row">
            <div class="label">Lines Viewed</div>
            <div class="value" id="gl-mr-lines-counts">0 / 0 (0%)</div>
          </div>
          <div class="bar"><span id="gl-mr-lines-bar"></span></div>
        </div>
        <div class="footer">
          <span class="muted" id="gl-mr-progress-remaining"></span>
          <span class="muted" id="gl-mr-progress-source"></span>
        </div>
      </div>
    `;

    makeDraggable(shadow.querySelector(".container"));

    return {
      host,
      shadow,
      countsEl: shadow.getElementById("gl-mr-progress-counts"),
      linesCountsEl: shadow.getElementById("gl-mr-lines-counts"),
      barEl: shadow.getElementById("gl-mr-files-bar"),
      linesBarEl: shadow.getElementById("gl-mr-lines-bar"),
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
          ".js-changes-tab-count, .gl-tab-counter-badge, .badge, .badge-counter, .counter"
        );
        const val = textToIntOrNull(badge ? badge.textContent : el.textContent);
        if (val != null && val > 0) return val;
      }
    }
    return null;
  }

  function parseAddedRemovedFromText(text) {
    if (!text) return null;
    const s = String(text).replace(/−/g, "-");
    const addMatch = s.match(/[+]\s*(\d{1,7})/);
    const remMatch = s.match(/[-]\s*(\d{1,7})/);
    if (!addMatch && !remMatch) return null;
    const added = addMatch ? parseInt(addMatch[1], 10) : 0;
    const removed = remMatch ? parseInt(remMatch[1], 10) : 0;
    return { added, removed };
  }

  // ---------------------------------------------------------------------------
  // Rapid Diffs (GitLab 18.x "Changes" tab)
  //
  // The page is server-rendered as a list of <diff-file> custom elements inside
  // a `[data-rapid-diffs]` root. The root carries a JSON `data-app-data`
  // attribute with the MR path and the metadata endpoints GitLab itself uses.
  // Viewed state is persisted by GitLab in localStorage under
  // `code-review-<mr_path>` as an array of `code_review_id` values, and is also
  // mirrored on each file's <article> as a `data-viewed` attribute.
  //
  // Counting every file exactly once by its `code_review_id` is what fixes the
  // double counting that the old DOM heuristics produced on this layout.
  // ---------------------------------------------------------------------------

  function getRapidDiffsRoot() {
    return document.querySelector("[data-rapid-diffs]");
  }

  let rapidAppDataCache = { raw: null, parsed: null };

  function getRapidAppData(root) {
    if (!root) return null;
    const raw = root.getAttribute("data-app-data");
    if (!raw) return null;
    if (rapidAppDataCache.raw === raw) return rapidAppDataCache.parsed;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = null;
    }
    rapidAppDataCache = { raw, parsed };
    return parsed;
  }

  // Per-file metadata for the whole MR (not just the files currently rendered).
  const rapidMeta = {
    endpoint: null,
    files: null, // [{ id, hash, path, added, removed }]
    loading: false,
    failed: false,
    fetchedAt: 0,
  };

  function normalizeMetaFiles(json) {
    const list = (json && json.diff_files) || [];
    const files = [];
    const seen = new Set();
    for (const f of list) {
      if (!f) continue;
      const id = f.code_review_id || f.file_identifier_hash || f.file_hash;
      const hash = f.file_hash || null;
      if (!id && !hash) continue;
      // Dedupe on the (id, hash) pair so two distinct files never collapse
      // into one even if GitLab hands out the same id for both.
      const dedupeKey = `${id}|${hash}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      files.push({
        id,
        hash,
        path: f.new_path || f.old_path || "",
        added: Number(f.added_lines) || 0,
        removed: Number(f.removed_lines) || 0,
      });
    }
    return files;
  }

  function ensureRapidMetadata(endpoint) {
    if (!endpoint) return;
    const url = new URL(endpoint, location.origin).toString();
    if (rapidMeta.endpoint === url) {
      // Retry a failed fetch every 15s at most.
      if (!rapidMeta.failed || Date.now() - rapidMeta.fetchedAt < 15000) return;
    }
    rapidMeta.endpoint = url;
    rapidMeta.files = null;
    rapidMeta.loading = true;
    rapidMeta.failed = false;
    rapidMeta.fetchedAt = Date.now();
    fetch(url, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (rapidMeta.endpoint !== url) return;
        rapidMeta.files = normalizeMetaFiles(json);
        rapidMeta.loading = false;
        updateUi();
      })
      .catch(() => {
        if (rapidMeta.endpoint !== url) return;
        rapidMeta.loading = false;
        rapidMeta.failed = true;
        updateUi();
      });
  }

  // Returns { ids: Set, ok: boolean }. `ok` is false when localStorage could
  // not be read at all (then the DOM is our only source of truth).
  function getViewedIdsFromStorage(mrPath) {
    const ids = new Set();
    if (!mrPath) return { ids, ok: false };
    try {
      const raw = localStorage.getItem(`code-review-${mrPath}`);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr))
          for (const id of arr) if (id) ids.add(String(id));
      }
      return { ids, ok: true };
    } catch (_) {
      return { ids, ok: false };
    }
  }

  function getRapidDomFiles() {
    // One entry per <diff-file> element currently rendered.
    const out = [];
    const els = document.querySelectorAll("diff-file");
    for (const el of els) {
      const id = el.getAttribute("data-code-review-id") || null;
      const hash = el.id || null;
      if (!id && !hash) continue;
      const article = el.firstElementChild;
      const checkbox = el.querySelector("[data-viewed-checkbox]");
      const viewed =
        !!(article && article.hasAttribute("data-viewed")) ||
        !!(checkbox && checkbox.checked);
      // GitLab enables the checkbox only once the file is mounted and its
      // viewed state has been applied. Before that, "unchecked" means nothing.
      const mounted = !!(checkbox && !checkbox.disabled);
      const stats = el.querySelector(
        '[data-testid="rd-diff-file-stats"], .rd-diff-file-stats'
      );
      const lr = stats ? parseAddedRemovedFromText(stats.textContent) : null;
      out.push({
        id: id || hash,
        hash,
        viewed,
        mounted,
        path: (el.querySelector(".rd-diff-file-title") || el).textContent.trim(),
        added: lr ? lr.added : 0,
        removed: lr ? lr.removed : 0,
      });
    }
    return out;
  }

  let lastRemainingSignature = null;

  function computeRapidProgress(root) {
    const appData = getRapidAppData(root) || {};
    ensureRapidMetadata(appData.diff_files_endpoint);

    const domFiles = getRapidDomFiles();
    const storage = getViewedIdsFromStorage(appData.mr_path);
    const viewedIds = storage.ids;
    const viewedHashes = new Set();
    // GitLab writes localStorage and the data-viewed attribute in the same
    // click handler, so storage is authoritative whenever it is readable.
    // Rendered files add to it (covers a missing/unreadable storage entry);
    // they only remove from it when storage itself could not be read.
    for (const f of domFiles) {
      if (f.viewed) {
        if (f.id) viewedIds.add(f.id);
        if (f.hash) viewedHashes.add(f.hash);
      } else if (!storage.ok && f.mounted) {
        viewedIds.delete(f.id);
      }
    }

    let files = rapidMeta.files;
    let source = "metadata";
    if (!files) {
      // Fall back to whatever is rendered while metadata loads (or if it failed).
      files = domFiles;
      source = rapidMeta.loading ? "loading" : "DOM";
    }

    let total = files.length;
    const declaredTotal = getDeclaredTotalFromTabs();
    if (source !== "metadata" && declaredTotal != null && declaredTotal > total)
      total = declaredTotal;

    let viewed = 0;
    let totalLines = 0;
    let reviewedLines = 0;
    const remaining = [];
    for (const f of files) {
      const lines = (f.added || 0) + (f.removed || 0);
      totalLines += lines;
      // Match by code_review_id first, then by file hash as a safety net in
      // case the page and the metadata endpoint disagree on the id.
      const isViewed =
        (f.id && viewedIds.has(f.id)) || (f.hash && viewedHashes.has(f.hash));
      if (isViewed) {
        viewed += 1;
        reviewedLines += lines;
      } else {
        remaining.push(f);
      }
    }

    // Help debugging "off by one" reports: whenever the set of unviewed files
    // changes and is small, list them once in the console.
    if (source === "metadata" && remaining.length <= 10) {
      const signature = remaining.map((f) => f.id || f.hash).join(",");
      if (signature !== lastRemainingSignature) {
        lastRemainingSignature = signature;
        if (remaining.length) {
          console.info(
            "[GitLab MR Progress] Not yet viewed:",
            remaining.map((f) => `${f.path} (+${f.added} -${f.removed})`)
          );
        }
      }
    }

    return { total, viewed, totalLines, reviewedLines, source };
  }

  // ---------------------------------------------------------------------------
  // Legacy (Vue-rendered) diffs view. Kept for older GitLab instances and for
  // users who turned Rapid Diffs off. Only used when no [data-rapid-diffs]
  // root exists on the page.
  // ---------------------------------------------------------------------------

  const LEGACY_CONTAINER_SELECTOR =
    '[data-testid="diff-file"], .diff-file, .file-holder, li.file';

  function getDeclaredLinesFromHeader() {
    const containers = [
      '[data-testid="diff-stats"]',
      ".diff-stats",
      ".diff-stats-summary",
      ".js-diff-stats",
      ".merge-request .diff-stats",
    ];
    for (const sel of containers) {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const pr = parseAddedRemovedFromText(el.textContent);
        if (pr && (pr.added > 0 || pr.removed > 0)) return pr;
      }
    }
    return null;
  }

  function getDiffFileContainers() {
    const all = Array.from(document.querySelectorAll(LEGACY_CONTAINER_SELECTOR));
    // Keep only outermost matches so a nested wrapper never counts twice.
    return all.filter(
      (el) =>
        el instanceof HTMLElement &&
        !(el.parentElement && el.parentElement.closest(LEGACY_CONTAINER_SELECTOR))
    );
  }

  function setFileStateForContainer(container, viewed) {
    const key = getFileKeyFromElement(container);
    if (!key) return;
    fileStateByKey.set(key, !!viewed);
    const lr = getFileAddedRemoved(container);
    if (lr) fileLinesByKey.set(key, { a: lr.added || 0, d: lr.removed || 0 });
  }

  function getFileAddedRemoved(container) {
    if (!container) return null;
    const scopes = [
      '[data-testid="file-header"]',
      ".file-header",
      ".diff-file-title",
      "header",
    ];
    let header = null;
    for (const sel of scopes) {
      const h = container.querySelector(sel);
      if (h) {
        header = h;
        break;
      }
    }
    const target = header || container;
    const statSelectors = [
      ".diff-stats",
      ".file-stats",
      ".gl-text-green",
      ".gl-text-red",
      ".text-success",
      ".text-danger",
      '[data-testid="added-lines"]',
      '[data-testid="removed-lines"]',
    ];
    for (const sel of statSelectors) {
      const parts = target.querySelectorAll(sel);
      if (parts && parts.length) {
        const pr = parseAddedRemovedFromText(
          Array.from(parts)
            .map((p) => p.textContent)
            .join(" ")
        );
        if (pr) return pr;
      }
    }
    return parseAddedRemovedFromText(target.textContent);
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

  function computeLegacyProgress() {
    // Merge states from file tree (likely complete) and visible diff containers
    const treeEntries = harvestFromFileTree();
    for (const [key, viewed] of treeEntries) {
      if (viewed) fileStateByKey.set(key, true);
      // Do not force false here; tree may virtualize and momentarily hide state
    }
    const containers = getDiffFileContainers();
    for (const c of containers) {
      const key = getFileKeyFromElement(c);
      if (!key) continue;
      const viewed =
        c.classList.contains("is-viewed") ||
        c.classList.contains("viewed") ||
        c.getAttribute("data-viewed") === "true" ||
        !!c.querySelector(
          'input[type="checkbox"]:checked, input[type="checkbox"][aria-checked="true"]'
        );
      if (viewed) fileStateByKey.set(key, true);
      const lr = getFileAddedRemoved(c);
      if (lr) fileLinesByKey.set(key, { a: lr.added || 0, d: lr.removed || 0 });
    }

    const declaredTotal = getDeclaredTotalFromTabs();
    const total =
      declaredTotal != null
        ? declaredTotal
        : Math.max(fileStateByKey.size, containers.length);
    let viewed = 0;
    for (const v of fileStateByKey.values()) if (v) viewed += 1;
    // Lines: total from header when available, else sum of parsed per-file values
    const declaredLines = getDeclaredLinesFromHeader();
    let totalLines = 0;
    if (declaredLines) {
      totalLines = (declaredLines.added || 0) + (declaredLines.removed || 0);
    } else {
      for (const { a, d } of fileLinesByKey.values())
        totalLines += (a || 0) + (d || 0);
    }
    let reviewedLines = 0;
    for (const [key, state] of fileStateByKey.entries()) {
      if (!state) continue;
      const lr = fileLinesByKey.get(key);
      if (lr) reviewedLines += (lr.a || 0) + (lr.d || 0);
    }
    return {
      total,
      viewed: Math.min(viewed, total || viewed),
      totalLines,
      reviewedLines,
      source: "legacy",
    };
  }

  function computeProgress() {
    const rapidRoot = getRapidDiffsRoot();
    if (rapidRoot) return computeRapidProgress(rapidRoot);
    return computeLegacyProgress();
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
    const { total, viewed, totalLines, reviewedLines, source } =
      computeProgress();
    const percent = total > 0 ? Math.round((viewed / total) * 100) : 0;
    const percentLines =
      totalLines > 0 ? Math.round((reviewedLines / totalLines) * 100) : 0;
    if (ui.countsEl)
      ui.countsEl.textContent = `${viewed} / ${total} (${percent}%)`;
    if (ui.linesCountsEl)
      ui.linesCountsEl.textContent = `${reviewedLines} / ${totalLines} (${percentLines}%)`;
    if (ui.barEl) ui.barEl.style.width = `${percent}%`;
    if (ui.linesBarEl) ui.linesBarEl.style.width = `${percentLines}%`;
    if (ui.remainingEl)
      ui.remainingEl.textContent = `${Math.max(0, total - viewed)} remaining`;
    if (ui.sourceEl) {
      if (source === "loading") ui.sourceEl.textContent = "loading…";
      else if (source === "DOM") ui.sourceEl.textContent = "partial";
      else ui.sourceEl.textContent = "";
    }
  }, 120);

  function bindLiveUpdates() {
    // Respond to checkbox changes (both layouts render "Viewed" as a checkbox)
    document.addEventListener(
      "change",
      (e) => {
        const target = e.target;
        if (!(target instanceof HTMLInputElement)) return;
        if (target.type !== "checkbox") return;
        if (!getRapidDiffsRoot()) {
          const container = target.closest(LEGACY_CONTAINER_SELECTOR);
          if (container) setFileStateForContainer(container, !!target.checked);
        }
        // GitLab flips data-viewed / localStorage in its own click handler,
        // which may run after this event. Recompute now and shortly after.
        updateUi();
        setTimeout(updateUi, 150);
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
          if (getRapidDiffsRoot()) {
            // Rapid Diffs: any tracked attribute flip means recompute from
            // authoritative sources; no per-element bookkeeping needed.
            updateUi();
            continue;
          }
          if (name === "checked" || name === "aria-checked") {
            const t = m.target;
            if (t instanceof HTMLInputElement && t.type === "checkbox") {
              const container = t.closest(LEGACY_CONTAINER_SELECTOR);
              if (container)
                setFileStateForContainer(
                  container,
                  t.checked || t.getAttribute("aria-checked") === "true"
                );
              updateUi();
              continue;
            }
          }
          if (name === "class" || name === "data-viewed") {
            const el = m.target;
            if (el instanceof HTMLElement) {
              const container = el.matches(LEGACY_CONTAINER_SELECTOR)
                ? el
                : el.closest(LEGACY_CONTAINER_SELECTOR);
              if (container) {
                const viewed =
                  container.classList.contains("is-viewed") ||
                  container.classList.contains("viewed") ||
                  container.getAttribute("data-viewed") === "true" ||
                  !!container.querySelector(
                    'input[type="checkbox"]:checked, input[type="checkbox"][aria-checked="true"]'
                  );
                setFileStateForContainer(container, viewed);
                updateUi();
                continue;
              }
            }
          }
        }
      }
    });

    // Try to find a stable diffs container; fallback to body
    const diffsContainer =
      document.querySelector("[data-rapid-diffs]") ||
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
