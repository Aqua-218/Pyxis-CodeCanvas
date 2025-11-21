// Shared Modules registry, loader and API
// This file implements a simplified SharedModuleRegistry and helper APIs

export type SharedModuleDescriptor = {
  name: string;
  version: string;
  cdnUrl?: string;
  localPath?: string;
  globalName?: string;
  dependencies?: string[];
  format: 'esm' | 'cjs' | 'umd';
  lazy?: boolean;
};

interface LoadedModule {
  descriptor: SharedModuleDescriptor;
  module: any;
  loadedAt: number;
  refCount: number;
}

export interface ModuleRequest {
  name: string;
  versionRange: string;
  optional?: boolean;
}

class SharedModuleRegistry {
  private descriptors: Map<string, SharedModuleDescriptor[]> = new Map();
  private loaded: Map<string, LoadedModule> = new Map();
  private loading: Map<string, Promise<any>> = new Map();
  private resolvers: Array<(name: string, version: string) => Promise<any> | null> = [];

  register(d: SharedModuleDescriptor) {
    const arr = this.descriptors.get(d.name) || [];
    arr.push(d);
    arr.sort((a, b) => this.compareVersions(b.version, a.version));
    this.descriptors.set(d.name, arr);
    console.log(`[SharedModuleRegistry] Registered: ${d.name}@${d.version}`);
  }

  registerAll(list: SharedModuleDescriptor[]) {
    for (const d of list) this.register(d);
  }

  addResolver(resolver: (name: string, version: string) => Promise<any> | null) {
    this.resolvers.push(resolver);
  }

  async require(name: string, versionRange: string = '*') {
    const cached = this.findCompatibleLoaded(name, versionRange);
    if (cached) {
      cached.refCount++;
      return cached.module;
    }
    const cacheKey = `${name}@${versionRange}`;
    if (this.loading.has(cacheKey)) return this.loading.get(cacheKey);
    const p = this.loadModule(name, versionRange);
    this.loading.set(cacheKey, p);
    try {
      const m = await p;
      return m;
    } finally {
      this.loading.delete(cacheKey);
    }
  }

  release(name: string, versionRange: string = '*') {
    const loaded = this.findCompatibleLoaded(name, versionRange);
    if (loaded) {
      loaded.refCount = Math.max(0, loaded.refCount - 1);
    }
  }

  async requireAll(requests: ModuleRequest[]) {
    const results = new Map<string, any>();
    await Promise.all(
      requests.map(async (req) => {
        try {
          const m = await this.require(req.name, req.versionRange);
          results.set(req.name, m);
        } catch (e) {
          if (!req.optional) throw e;
          console.warn(`[SharedModuleRegistry] Optional module not available: ${req.name}`);
        }
      })
    );
    return results;
  }

  getAvailableModules() {
    const out: Array<{ name: string; versions: string[] }> = [];
    for (const [name, desc] of this.descriptors) {
      out.push({ name, versions: desc.map(d => d.version) });
    }
    return out;
  }

  private async loadModule(name: string, versionRange: string) {
    const descriptor = this.findCompatibleDescriptor(name, versionRange);
    if (!descriptor) throw new Error(`No compatible descriptor for ${name}@${versionRange}`);

    if (descriptor.dependencies) {
      for (const dep of descriptor.dependencies) await this.require(dep);
    }

    for (const r of this.resolvers) {
      const res = await r(name, descriptor.version);
      if (res) return this.cacheModule(descriptor, res);
    }

    if (descriptor.localPath) {
      try {
        const mod = await this.loadFromLocal(descriptor);
        return this.cacheModule(descriptor, mod);
      } catch (e) {
        console.warn(`[SharedModuleRegistry] local load failed for ${name}`, e);
      }
    }

    if (descriptor.cdnUrl) {
      try {
        const mod = await this.loadFromCdn(descriptor);
        return this.cacheModule(descriptor, mod);
      } catch (e) {
        console.warn(`[SharedModuleRegistry] CDN load failed for ${name}`, e);
      }
    }

    if (descriptor.globalName && typeof window !== 'undefined') {
      const g = (window as any)[descriptor.globalName];
      if (g) return this.cacheModule(descriptor, g);
    }

    throw new Error(`Could not load shared module ${name}@${descriptor.version}`);
  }

  private async loadFromLocal(descriptor: SharedModuleDescriptor) {
    const url = descriptor.localPath!.startsWith('/') ? descriptor.localPath! : `/${descriptor.localPath}`;
    if (descriptor.format === 'esm') return import(/* webpackIgnore: true */ url);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => {
        if (descriptor.globalName) resolve((window as any)[descriptor.globalName]);
        else reject(new Error('UMD module requires globalName'));
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  private async loadFromCdn(descriptor: SharedModuleDescriptor) {
    const url = descriptor.cdnUrl!;
    if (descriptor.format === 'esm') return import(/* webpackIgnore: true */ url);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => {
        if (descriptor.globalName) resolve((window as any)[descriptor.globalName]);
        else reject(new Error('UMD module requires globalName'));
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  private cacheModule(descriptor: SharedModuleDescriptor, module: any) {
    const key = `${descriptor.name}@${descriptor.version}`;
    this.loaded.set(key, { descriptor, module, loadedAt: Date.now(), refCount: 1 });
    console.log(`[SharedModuleRegistry] Loaded: ${key}`);
    return module;
  }

  private findCompatibleLoaded(name: string, versionRange: string) {
    for (const [k, v] of this.loaded) {
      if (k.startsWith(`${name}@`) && this.satisfies(v.descriptor.version, versionRange)) return v;
    }
    return null;
  }

  private findCompatibleDescriptor(name: string, versionRange: string) {
    const list = this.descriptors.get(name);
    if (!list) return null;
    for (const d of list) if (this.satisfies(d.version, versionRange)) return d;
    return null;
  }

  private satisfies(version: string, range: string) {
    if (range === '*' || range === 'latest') return true;
    if (range.startsWith('^')) {
      const rv = range.slice(1);
      const [maj] = this.parseVersion(rv);
      const [vmaj] = this.parseVersion(version);
      return maj === vmaj && this.compareVersions(version, rv) >= 0;
    }
    if (range.startsWith('~')) {
      const rv = range.slice(1);
      const [maj, min] = this.parseVersion(rv);
      const [vmaj, vmin] = this.parseVersion(version);
      return maj === vmaj && min === vmin && this.compareVersions(version, rv) >= 0;
    }
    if (range.startsWith('>=')) return this.compareVersions(version, range.slice(2)) >= 0;
    return version === range;
  }

  private parseVersion(v: string) { const parts = v.replace(/^[^0-9]*/, '').split('.').map(Number); return [parts[0] || 0, parts[1] || 0, parts[2] || 0]; }
  private compareVersions(a: string, b: string) { const [aM, aN, aP] = this.parseVersion(a); const [bM, bN, bP] = this.parseVersion(b); if (aM !== bM) return aM - bM; if (aN !== bN) return aN - bN; return aP - bP; }
}

export const sharedModuleRegistry = new SharedModuleRegistry();

// host config
export const SHARED_MODULES_CONFIG: SharedModuleDescriptor[] = [
  { name: 'react', version: '18.2.0', format: 'esm', globalName: '__PYXIS_REACT__' },
  { name: 'react-dom', version: '18.2.0', format: 'esm', globalName: '__PYXIS_REACT_DOM__', dependencies: ['react'] },
  { name: 'react-markdown', version: '9.0.1', format: 'esm', cdnUrl: 'https://esm.sh/react-markdown@9.0.1?external=react', dependencies: ['react'] },
  { name: 'remark-gfm', version: '4.0.0', format: 'esm', cdnUrl: 'https://esm.sh/remark-gfm@4.0.0', localPath: '/shared-modules/remark-gfm/4.0.0/index.esm.js' },
  { name: 'remark-math', version: '6.0.0', format: 'esm', cdnUrl: 'https://esm.sh/remark-math@6.0.0', localPath: '/shared-modules/remark-math/6.0.0/index.esm.js' },
  { name: 'rehype-katex', version: '7.0.0', format: 'esm', cdnUrl: 'https://esm.sh/rehype-katex@7.0.0', dependencies: ['katex'], localPath: '/shared-modules/rehype-katex/7.0.0/index.esm.js' },
  { name: 'katex', version: '0.16.9', format: 'esm', cdnUrl: 'https://esm.sh/katex@0.16.9', localPath: '/shared-modules/katex/0.16.9/index.esm.js' },
  { name: 'prismjs', version: '1.29.0', format: 'umd', cdnUrl: 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js', globalName: 'Prism' },
  { name: 'highlight.js', version: '11.9.0', format: 'esm', cdnUrl: 'https://esm.sh/highlight.js@11.9.0' },
  { name: 'lodash', version: '4.17.21', format: 'esm', cdnUrl: 'https://esm.sh/lodash-es@4.17.21' },
  { name: 'date-fns', version: '3.0.0', format: 'esm', cdnUrl: 'https://esm.sh/date-fns@3.0.0', lazy: true },
];

export function getExternalsFromSharedModules() { return SHARED_MODULES_CONFIG.map(m => m.name); }

// loader that injects shared modules into entry code
export function escapeRegex(str: string) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export async function loadExtensionWithSharedModules(entryCode: string, manifest: { sharedDependencies?: ModuleRequest[] }, context: any) {
  const sharedModules = manifest.sharedDependencies ? await sharedModuleRegistry.requireAll(manifest.sharedDependencies) : new Map();
  let transformed = entryCode;

  for (const [name, module] of sharedModules) {
    const globalKey = `__PYXIS_SHARED_${name.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}__`;
    (window as any)[globalKey] = module;

    const patterns = [
      { regex: new RegExp(`import\\s+(\\w+)\\s+from\\s+['"]${escapeRegex(name)}['"];?`, 'g'), replace: `const $1 = window.${globalKey}.default || window.${globalKey};` },
      { regex: new RegExp(`import\\s+\\{([^}]+)\\}\\s+from\\s+['"]${escapeRegex(name)}['"];?`, 'g'), replace: `const {$1} = window.${globalKey};` },
      { regex: new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"]${escapeRegex(name)}['"];?`, 'g'), replace: `const $1 = window.${globalKey};` },
      { regex: new RegExp(`import\\s+(\\w+)\\s*,\\s*\\{([^}]+)\\}\\s+from\\s+['"]${escapeRegex(name)}['"];?`, 'g'), replace: `const $1 = window.${globalKey}.default || window.${globalKey}; const {$2} = window.${globalKey};` },
    ];

    for (const p of patterns) transformed = transformed.replace(p.regex, p.replace);
  }

  const blob = new Blob([transformed], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    const module = await import(/* webpackIgnore: true */ url);
    return module;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// create SharedModules API used by ExtensionContext
export interface SharedModulesAPI {
  require: <T = any>(name: string, versionRange?: string) => Promise<T>;
  release: (name: string, versionRange?: string) => void;
  getAvailable: () => Array<{ name: string; versions: string[] }>;
}

export function createSharedModulesAPI(extensionId: string): SharedModulesAPI {
  const used: Array<{ name: string; versionRange: string }> = [];
  return {
    require: async <T = any>(name: string, versionRange: string = '*') => {
      const m = await sharedModuleRegistry.require(name, versionRange);
      used.push({ name, versionRange });
      return m as T;
    },
    release: (name: string, versionRange: string = '*') => {
      sharedModuleRegistry.release(name, versionRange);
      const idx = used.findIndex(u => u.name === name && u.versionRange === versionRange);
      if (idx >= 0) used.splice(idx, 1);
    },
    getAvailable: () => sharedModuleRegistry.getAvailableModules(),
  };
}

export async function initializeSharedModules() {
  console.log('[SharedModules] Initializing...');
  sharedModuleRegistry.registerAll(SHARED_MODULES_CONFIG);
  sharedModuleRegistry.addResolver(async (name, version) => {
    if (typeof window === 'undefined') return null;
    if (name === 'react') return (window as any).__PYXIS_REACT__;
    if (name === 'react-dom') return (window as any).__PYXIS_REACT_DOM__;
    if (name === 'katex') return (window as any).__PYXIS_KATEX__;
    return null;
  });

  const preload = ['react', 'react-dom'];
  for (const n of preload) {
    try { await sharedModuleRegistry.require(n); } catch (e) { console.warn('[SharedModules] preload failed', n); }
  }
  console.log('[SharedModules] Initialized');
}

// Extended manifest type used by loader
export interface ExtendedExtensionManifest {
  sharedDependencies?: ModuleRequest[];
}
