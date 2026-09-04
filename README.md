### GitLab MR Review Progress (Firefox/Zen)

Shows a live progress indicator of viewed files and viewed lines on GitLab merge request "Changes" pages. It reads the page (and, on current GitLab, the same file-metadata endpoint the page itself loads) and adapts to GitLab's theme automatically.

### Install (Firefox or Zen)

1. Download the latest signed `.xpi` from the [Releases page](https://github.com/erxand/gitlab-progress-extension/releases/latest).
2. Open `about:addons`, click the gear icon, choose "Install Add-on From File…", and pick the downloaded `.xpi`.

The `.xpi` is signed by Mozilla's add-on service, so it installs permanently and survives browser restarts. It is distributed here rather than on addons.mozilla.org.

### How it counts (GitLab "Rapid Diffs", the current Changes tab)

GitLab now renders the Changes tab as a list of `<diff-file>` elements inside a `[data-rapid-diffs]` root. The extension:

- Reads the MR path and the `diff_files_metadata` endpoint from the root's `data-app-data` attribute and fetches the per-file metadata once (file id, added lines, removed lines). That list is the authoritative set of files, so every file is counted exactly once, whether or not it is currently rendered.
- Reads viewed state from the same place GitLab persists it: `localStorage["code-review-<mr_path>"]` (an array of file ids), plus the `data-viewed` attribute GitLab sets on each rendered file. The rendered state wins for files that are on screen.
- Falls back to the tab badge and the rendered files while the metadata is loading (the footer shows `loading…`) or if the fetch fails (footer shows `partial`).

Older GitLab instances (or Rapid Diffs turned off) still use the previous DOM heuristics.

### Releasing a new version

1. Bump `version` in `manifest.json` and `package.json`.
2. Sign (see below) to get a new `.xpi` in `web-ext-artifacts/`.
3. Commit, tag, and publish a GitHub Release with the `.xpi` attached:

   ```bash
   git tag v<version>
   git push origin main --tags
   gh release create v<version> web-ext-artifacts/*.xpi --title "v<version>" --notes "<what changed>"
   ```

### Install for development (temporary load)

- Open Firefox or Zen and go to `about:debugging#/runtime/this-firefox`.
- Click "Load Temporary Add-on" and select this folder's `manifest.json`.
- Navigate to a GitLab MR "Changes" tab. A floating progress widget appears in the top-right.

Temporary add-ons are removed when the browser restarts. For a permanent install, sign it (below).

### Permanent install: sign with AMO (one-time setup)

Firefox and Zen only keep signed add-ons across restarts. Zen ignores the `xpinstall.signatures.required` about:config flag, so signing is the only route. Signing an "unlisted" add-on is free, automated, and does not publish it anywhere; you just get a signed `.xpi` back.

1. Create or sign in to an account at <https://addons.mozilla.org>.
2. Generate API credentials at <https://addons.mozilla.org/developers/addon/api/key/>. You get a JWT issuer and a JWT secret.
3. Install the tooling once:

   ```bash
   npm install
   ```

4. Sign (bump `version` in `manifest.json` first if you have signed this version before; AMO refuses duplicate versions):

   ```bash
   WEB_EXT_API_KEY="<jwt issuer>" WEB_EXT_API_SECRET="<jwt secret>" npm run sign
   ```

   The signed file lands in `web-ext-artifacts/*.xpi`. The add-on id is fixed in `manifest.json` under `browser_specific_settings.gecko.id`, so future versions update the same add-on.

5. In Zen or Firefox, open `about:addons`, click the gear icon, choose "Install Add-on From File…", and pick the `.xpi`. It now survives restarts. Repeat step 4 and 5 for each new version.

Other scripts:

```bash
npm run lint    # web-ext lint (manifest and code checks AMO also runs)
npm run build   # unsigned zip in web-ext-artifacts/
npm run start   # launch a temporary Firefox profile with the extension loaded
```

### What it does

- Displays `Files Viewed X / Y (Z%)` and `Lines Viewed X / Y (Z%)` with progress bars, plus a remaining-files count.
- Updates live when you mark a file as viewed or unviewed, when more diffs stream in, and on SPA navigation.
- Theme-aware: colors are derived from the page's current theme (light/dark/custom). You can drag the widget to reposition it.

### When it shows

- Only on MR diffs pages, e.g. `.../merge_requests/:id/diffs`.
- It hides on MR overview, Commits, and other tabs.

### Notes / Troubleshooting

- The content script only runs on `https://gitlab.com/*`. For a self-hosted GitLab, add its origin to `content_scripts[].matches` in `manifest.json` and re-sign.
- If the footer says `partial`, the metadata request failed and the count only covers files rendered so far. Reload the page.
- No data is stored or sent anywhere other than GitLab itself; the only network request is to the MR's own metadata endpoint on the same origin.
