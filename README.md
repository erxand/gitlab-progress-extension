### GitLab MR Review Progress (Firefox/Zen)

Shows a live progress indicator of viewed files on GitLab merge request "Changes" pages. No API calls; it parses the DOM and adapts to GitLab’s theme automatically.

### Install (temporary load)

- Open Firefox or Zen and go to `about:debugging#/runtime/this-firefox`.
- Click "Load Temporary Add-on" and select this folder's `manifest.json`.
- Navigate to a GitLab MR "Changes" tab. A floating progress widget will appear in the top-right.

### Package for permanent install

Firefox requires signed add-ons for permanent installation. Two options:

1. Sign and install via AMO (recommended)

- Create an account on Mozilla Add-ons (AMO).
- Zip the extension contents (keep `manifest.json` at the zip root).
- Submit for signing (you can keep it unlisted/private). AMO returns signed `.xpi`.
- In Firefox/Zen, open the `.xpi` to install permanently.

2. Self-sign with web-ext (for development/CI)

- Install `web-ext` (`npm i -g web-ext`).
- Build and sign:

  ```bash
  web-ext sign --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET --artifacts-dir ./web-ext-artifacts
  ```

- The signed `.xpi` in `web-ext-artifacts` can be installed permanently.

Notes:

- Zen is Firefox-based; installing the signed `.xpi` works the same.
- If you only need local development, use the temporary load steps above.

### What it does

- Computes progress using both the visible diffs and the file tree, maintaining a stable count as you scroll.
- Uses the “Changes” tab badge as the authoritative total when available.
- Updates live when:
  - You mark a file as viewed/unviewed.
  - New diffs are loaded (e.g., lazy loading, expand all, etc.).
  - The page updates via SPA navigation.
- Displays: `Reviewed X / Y (Z%)`, remaining count, and a progress bar.
- Theme-aware: colors are derived from the page’s current theme (light/dark/custom). You can drag the widget to reposition it.

### When it shows

- Only on MR diffs pages, e.g. `.../merge_requests/:id/diffs`.
- It hides on MR overview, Commits, and other tabs.

### Notes / Troubleshooting

- Counts stabilize after you’ve scrolled through the list once (GitLab virtualizes diffs). The total uses the tab badge when present.
- If counts look off on your instance, please open an issue with a URL example; selectors can vary across GitLab versions.
- No data is stored or sent anywhere; it purely reads the page and renders a local widget.
