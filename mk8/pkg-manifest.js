// Where the wasm bundle's files are (docs/NETWORK.md §1). The build names them by content hash
// (pkg/mk8_web.<hash>.js, pkg/mk8_web_bg.<hash>.wasm, pkg/mk8_audio_worklet.<hash>.wasm; served
// immutable) and writes pkg/manifest.json { "<unhashed name>": "<hashed name>" }. The page
// resolves every bundle file through the manifest, fetched fresh on every load (`no-store`, and
// the server sends it `no-cache`), so a deploy can never pair this page with an hour-old cached
// bundle: a new build is a new set of names. A pkg/ without a manifest (an older build) falls
// back to the unhashed names.
const PKG_DIR = '../pkg/';
let manifest = null;

/** The manifest, `{}` when there is none (one fetch per page load). */
export function pkgManifest() {
  if (!manifest) {
    manifest = (async () => {
      const url = new URL(PKG_DIR + 'manifest.json', import.meta.url);
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) {
          const m = await r.json();
          if (m && typeof m === 'object' && !Array.isArray(m)) return m;
          console.warn('pkg/manifest.json is not an object; using the unhashed bundle names');
        } else if (r.status !== 404) {
          console.warn(`pkg/manifest.json: HTTP ${r.status}; using the unhashed bundle names`);
        }
      } catch (e) {
        console.warn('pkg/manifest.json unavailable; using the unhashed bundle names', e);
      }
      return {};
    })();
  }
  return manifest;
}

/** URL of a bundle file by its unhashed name (`'mk8_web.js'`, `'mk8_web_bg.wasm'`, ...). */
export async function pkgUrl(name) {
  const m = await pkgManifest();
  const mapped = m[name];
  // A manifest entry is a plain file name next to the manifest; anything else is ignored.
  const file = typeof mapped === 'string' && /^[\w.-]+$/.test(mapped) ? mapped : name;
  return new URL(PKG_DIR + file, import.meta.url);
}
