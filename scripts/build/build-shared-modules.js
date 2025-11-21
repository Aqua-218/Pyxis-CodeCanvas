#!/usr/bin/env node
/*
 * Build/generate local shared-module ESM wrappers.
 * The wrappers prefer host-injected globals (window.__PYXIS_MARKDOWN__ / window.__PYXIS_KATEX__),
 * and fall back to importing from esm.sh CDN. These files are written to
 * `public/shared-modules/<pkg>/<version>/index.esm.js` so they're served locally.
 */
const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeWrapper(pkgName, version, specifier, hostLookup) {
  const outDir = path.join(process.cwd(), 'public', 'shared-modules', pkgName, version);
  ensureDir(outDir);
  const outPath = path.join(outDir, 'index.esm.js');
  const code = `// AUTO-GENERATED wrapper for ${pkgName}@${version}
// Prefers host global, falls back to CDN
const __host = typeof window !== 'undefined' ? (window.__PYXIS_MARKDOWN__ || window.__PYXIS_KATEX__ || null) : null;
let _mod;
if (__host && ${hostLookup}) {
  _mod = { default: ${hostLookup} };
} else {
  _mod = await import('${specifier}');
}
const _default = _mod && (_mod.default || _mod);
export default _default;
export const __raw = _mod;
`;
  fs.writeFileSync(outPath, code, 'utf8');
  console.log(`Wrote ${outPath}`);
}

async function main() {
  const rootPkg = require(path.join(process.cwd(), 'package.json'));
  const deps = rootPkg.dependencies || {};

  const modules = [
    { name: 'react-markdown', hostLookup: '(__host && __host.ReactMarkdown)', spec: (v) => `https://esm.sh/react-markdown@${v}?external=react` },
    { name: 'remark-gfm', hostLookup: '(__host && __host.remarkGfm)', spec: (v) => `https://esm.sh/remark-gfm@${v}` },
    { name: 'remark-math', hostLookup: '(__host && __host.remarkMath)', spec: (v) => `https://esm.sh/remark-math@${v}` },
    { name: 'rehype-katex', hostLookup: '(__host && __host.rehypeKatex)', spec: (v) => `https://esm.sh/rehype-katex@${v}` },
    { name: 'katex', hostLookup: '(__host && __host.katex)', spec: (v) => `https://esm.sh/katex@${v}` },
  ];

  for (const m of modules) {
    const vRange = deps[m.name];
    if (!vRange) {
      console.warn(`Skipped ${m.name}: not found in root package.json dependencies`);
      continue;
    }

    // try to read installed package.json to get exact version
    const pkgJsonPath = path.join(process.cwd(), 'node_modules', m.name, 'package.json');
    let version = vRange.replace(/^[^0-9]*/, '');
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const pj = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        version = pj.version || version;
      }
    } catch (e) {
      console.warn(`Failed to read ${pkgJsonPath}`, e);
    }

    const specifier = m.spec(version);
    writeWrapper(m.name, version, specifier, m.hostLookup);
  }

  console.log('Shared-module wrappers generated.');
}

main().catch((e) => { console.error(e); process.exit(1); });
