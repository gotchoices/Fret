description: The release step that waits for the new version to appear on npm now counts a package as published only once its download file can actually be fetched, not just once npm lists the version.
files: scripts/published-visibility.js, scripts/await-published.js, scripts/published-visibility.test.js, AGENTS.md
----
# `yarn await-published` waits for each package's tarball — complete

Port of optimystic's `ticket(implement)` / `ticket(review)` of the same slug.

`yarn await-published` used to count a package as published once `npm view <name>@<version> version` echoed the version. That reads registry metadata; the tarball `npm install` downloads is served separately and later (sereus 1.8.0: every version listed while three tarballs answered 404 for minutes). Now a package counts only when both hold:

1. `npm view --json <spec> version dist.tarball` lists the version with an http(s) `dist.tarball`, and
2. a `HEAD` of that URL, sent with `cache-control: no-cache`, answers 200.

Pure half, `scripts/published-visibility.js`: `readViewAnswer` returns `{ listed, tarball | reason }` (typedef `ViewAnswer`); `readListing` accepts the object npm prints for two fields and the bare version string npm prints when `dist.tarball` is absent (listed, no tarball → not visible); `isHttpUrl` refuses non-http(s) URLs (`fetch` answers `data:` with 200 without asking anyone); `readTarballAnswer(status)` gives the verdict (200 visible, 404 `TARBALL_NOT_YET_DOWNLOADABLE`, else `tarball answered HTTP <n>`). The wait's probe type is now `Visibility`. Impure half, `scripts/await-published.js`: `probe` runs `npm view`, then `probeTarball` only when listed; a rejected fetch becomes a printed reason, never a throw. Three `NOTE:` tripwires carried over: CDN edges may ignore `no-cache` (at `REVALIDATE`), no npm credentials on the fetch, and no `dist-tags.latest` check (both at `probeTarball`). AGENTS.md § Releasing describes both checks.

Testing: `yarn test:scripts` 15/15 (new: tarball listed, bare-version-means-no-tarball, non-http(s) tarball refused, `readTarballAnswer` 200/404). Live: `npm view --json p2p-fret@1.0.0 version dist.tarball` prints `{ "version", "dist.tarball" }` (npm 11.3.0), and `node scripts/await-published.js` → `all 1 packages published and visible on npm at 1.0.0`. No lint step exists in this repo.
