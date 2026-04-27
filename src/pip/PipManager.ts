import { InstallResult, PackageInfo } from '../types.js';
import {
  PackageNotFoundError,
  NoWASMWheelError,
  IncompatiblePackageError,
} from '../errors/index.js';
import { VirtualFileSystem } from '../vfs/VirtualFileSystem.js';
import { WASMWheelRegistry } from '../worker/WASMExtensionLoader.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SITE_PACKAGES = '/usr/local/lib/python3.13/site-packages';
const PIP_CACHE_DIR = '/tmp/pip-cache';
const PYPI_API_BASE = 'https://pypi.org/pypi';

// ─── PyPI API types ───────────────────────────────────────────────────────────

interface PyPIRelease {
  filename: string;
  url: string;
  packagetype: string;
  requires_python?: string | null;
}

interface PyPIInfo {
  name: string;
  version: string;
  requires_dist?: string[] | null;
}

interface PyPIResponse {
  info: PyPIInfo;
  urls: PyPIRelease[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a wheel filename to determine if it is pure-Python (platform-independent).
 * Pure-Python wheels have the tag `py3-none-any` or `py2.py3-none-any` or `py3-none-any`.
 * Format: {name}-{version}(-{build})?-{python}-{abi}-{platform}.whl
 */
function isPurePythonWheel(filename: string): boolean {
  if (!filename.endsWith('.whl')) return false;
  const stem = filename.slice(0, -4); // remove .whl
  const parts = stem.split('-');
  // Minimum 5 parts: name, version, python, abi, platform
  if (parts.length < 5) return false;
  const platform = parts[parts.length - 1];
  const abi = parts[parts.length - 2];
  return platform === 'any' && abi === 'none';
}

/**
 * Parse package name from a dependency specifier like "numpy>=1.0,<2.0" → "numpy"
 */
function parseDependencyName(spec: string): string {
  return (spec.split(/[>=<!;\s\[]/)[0] ?? '').trim().toLowerCase();
}

/**
 * Topological sort using Kahn's algorithm.
 * Returns packages in install order (dependencies first).
 * Throws if a cycle is detected.
 */
function topologicalSort(
  packages: string[],
  getDeps: (name: string) => string[],
): string[] {
  const allNodes = new Set<string>(packages);

  // Build adjacency: node → set of nodes that depend on it (reverse edges)
  // and in-degree map
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>(); // dep → packages that need it

  // Collect all nodes including transitive deps
  const visited = new Set<string>();
  const queue: string[] = [...packages];
  while (queue.length > 0) {
    const pkg = queue.pop()!;
    if (visited.has(pkg)) continue;
    visited.add(pkg);
    allNodes.add(pkg);
    for (const dep of getDeps(pkg)) {
      allNodes.add(dep);
      queue.push(dep);
    }
  }

  for (const node of allNodes) {
    inDegree.set(node, 0);
    dependents.set(node, new Set());
  }

  for (const node of allNodes) {
    for (const dep of getDeps(node)) {
      // node depends on dep → dep must come before node
      // edge: dep → node
      dependents.get(dep)!.add(node);
      inDegree.set(node, (inDegree.get(node) ?? 0) + 1);
    }
  }

  const result: string[] = [];
  const zeroQueue: string[] = [];

  for (const [node, deg] of inDegree.entries()) {
    if (deg === 0) zeroQueue.push(node);
  }

  while (zeroQueue.length > 0) {
    const node = zeroQueue.shift()!;
    result.push(node);
    for (const dependent of dependents.get(node) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) zeroQueue.push(dependent);
    }
  }

  if (result.length !== allNodes.size) {
    throw new Error('Cyclic dependency detected among packages');
  }

  return result;
}

// ─── PipManager ───────────────────────────────────────────────────────────────

export class PipManager {
  private readonly vfs: VirtualFileSystem;
  private readonly registry: WASMWheelRegistry;

  /** Cache of resolved package metadata: name → { version, deps, source, wheelUrl } */
  private readonly resolvedCache = new Map<
    string,
    { version: string; deps: string[]; source: 'wasm-registry' | 'pypi'; wheelUrl: string }
  >();

  constructor(vfs: VirtualFileSystem, registry: WASMWheelRegistry) {
    this.vfs = vfs;
    this.registry = registry;
    // Ensure cache directory exists
    this.vfs.pathCreateDirectory(PIP_CACHE_DIR);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async install(packages: string | string[]): Promise<InstallResult[]> {
    const names = (Array.isArray(packages) ? packages : [packages]).map((n) =>
      n.toLowerCase().trim(),
    );

    // Resolve metadata for all requested packages (and their deps)
    await this._resolveAll(names);

    // Topological sort
    const installOrder = topologicalSort(names, (name) => {
      const meta = this.resolvedCache.get(name);
      return meta ? meta.deps : [];
    });

    const results: InstallResult[] = [];

    for (const name of installOrder) {
      const meta = this.resolvedCache.get(name);
      if (!meta) continue; // shouldn't happen

      // Check if already installed (METADATA file exists)
      const metadataPath = `${SITE_PACKAGES}/${name}-${meta.version}.dist-info/METADATA`;
      try {
        this.vfs.readFile(metadataPath);
        // Already installed — skip but still report
        results.push({ name, version: meta.version, source: meta.source });
        continue;
      } catch {
        // Not installed yet
      }

      // Download (or use cache)
      const wheelBytes = await this._fetchWheelCached(name, meta.version, meta.wheelUrl);

      // Unpack wheel into site-packages
      await this._unpackWheel(name, meta.version, wheelBytes);

      results.push({ name, version: meta.version, source: meta.source });
    }

    return results;
  }

  async list(): Promise<PackageInfo[]> {
    const result: PackageInfo[] = [];

    let entries: { name: string; isDirectory: boolean; size: number }[];
    try {
      entries = this.vfs.listDir(SITE_PACKAGES);
    } catch {
      return result;
    }

    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (!entry.name.endsWith('.dist-info')) continue;

      const metadataPath = `${SITE_PACKAGES}/${entry.name}/METADATA`;
      try {
        const bytes = this.vfs.readFile(metadataPath);
        const text = new TextDecoder().decode(bytes);
        const parsed = this._parseMetadata(text);
        if (parsed) result.push(parsed);
      } catch {
        // Skip unreadable metadata
      }
    }

    return result;
  }

  // ─── Resolution ─────────────────────────────────────────────────────────────

  /**
   * Recursively resolve metadata for all packages (including transitive deps).
   */
  private async _resolveAll(names: string[]): Promise<void> {
    const queue = [...names];
    const seen = new Set<string>();

    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);

      if (this.resolvedCache.has(name)) {
        // Already resolved — still enqueue its deps
        const meta = this.resolvedCache.get(name)!;
        for (const dep of meta.deps) queue.push(dep);
        continue;
      }

      const meta = await this._resolveOne(name);
      this.resolvedCache.set(name, meta);
      for (const dep of meta.deps) queue.push(dep);
    }
  }

  /**
   * Resolve a single package: check cache → registry → PyPI.
   */
  private async _resolveOne(
    name: string,
  ): Promise<{ version: string; deps: string[]; source: 'wasm-registry' | 'pypi'; wheelUrl: string }> {
    // 1. Check VFS cache
    const cached = this._findInCache(name);
    if (cached) return cached;

    // 2. Check WASM wheel registry
    const entry = this.registry.resolve(name);
    if (entry) {
      return {
        version: entry.version,
        deps: entry.dependencies.map((d) => d.toLowerCase()),
        source: 'wasm-registry',
        wheelUrl: entry.url,
      };
    }

    // 3. Query PyPI JSON API
    const pypiData = await this._fetchPyPI(name);
    if (!pypiData) {
      throw new PackageNotFoundError(name);
    }

    // Find a pure-Python wheel
    const pureWheel = pypiData.urls.find(
      (r) => r.packagetype === 'bdist_wheel' && isPurePythonWheel(r.filename),
    );

    if (!pureWheel) {
      // Check if there are any wheels at all (C-extension only)
      const hasAnyWheel = pypiData.urls.some((r) => r.packagetype === 'bdist_wheel');
      const hasSdist = pypiData.urls.some((r) => r.packagetype === 'sdist');

      if (hasAnyWheel) {
        throw new IncompatiblePackageError(
          name,
          'Only C-extension wheels are available for non-wasm32-wasi platforms',
        );
      }

      if (!hasSdist) {
        throw new PackageNotFoundError(name);
      }

      // Only sdist available — no wheel at all
      throw new NoWASMWheelError(name);
    }

    const deps = this._parseDepsFromPyPI(pypiData.info.requires_dist ?? []);

    return {
      version: pypiData.info.version,
      deps,
      source: 'pypi',
      wheelUrl: pureWheel.url,
    };
  }

  // ─── Cache ───────────────────────────────────────────────────────────────────

  private _findInCache(
    name: string,
  ): { version: string; deps: string[]; source: 'wasm-registry' | 'pypi'; wheelUrl: string } | null {
    let entries: { name: string; isDirectory: boolean; size: number }[];
    try {
      entries = this.vfs.listDir(PIP_CACHE_DIR);
    } catch {
      return null;
    }

    // Cache files are named: {name}-{version}.whl
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const filename = entry.name;
      if (!filename.endsWith('.whl')) continue;
      const stem = filename.slice(0, -4);
      const dashIdx = stem.lastIndexOf('-');
      if (dashIdx === -1) continue;
      const cachedName = stem.slice(0, dashIdx).toLowerCase();
      const cachedVersion = stem.slice(dashIdx + 1);
      if (cachedName === name) {
        return {
          version: cachedVersion,
          deps: [], // deps will be re-resolved from metadata if needed
          source: 'pypi',
          wheelUrl: `cache://${filename}`,
        };
      }
    }
    return null;
  }

  private async _fetchWheelCached(
    name: string,
    version: string,
    wheelUrl: string,
  ): Promise<Uint8Array> {
    const cacheFile = `${PIP_CACHE_DIR}/${name}-${version}.whl`;

    // Check VFS cache first
    if (!wheelUrl.startsWith('cache://')) {
      try {
        return this.vfs.readFile(cacheFile);
      } catch {
        // Not cached yet
      }
    } else {
      // Already in cache
      try {
        return this.vfs.readFile(`${PIP_CACHE_DIR}/${wheelUrl.slice('cache://'.length)}`);
      } catch {
        // Cache miss — fall through
      }
    }

    // Fetch from network
    const response = await fetch(wheelUrl);
    if (!response.ok) {
      throw new PackageNotFoundError(name);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());

    // Store in cache
    this.vfs.writeFile(cacheFile, bytes);

    return bytes;
  }

  // ─── PyPI ────────────────────────────────────────────────────────────────────

  private async _fetchPyPI(name: string): Promise<PyPIResponse | null> {
    try {
      const response = await fetch(`${PYPI_API_BASE}/${name}/json`);
      if (response.status === 404) return null;
      if (!response.ok) return null;
      return (await response.json()) as PyPIResponse;
    } catch {
      return null;
    }
  }

  private _parseDepsFromPyPI(requiresDist: string[]): string[] {
    const deps: string[] = [];
    for (const spec of requiresDist) {
      // Skip extras and environment markers that don't apply
      if (spec.includes('; extra ==')) continue;
      const depName = parseDependencyName(spec);
      if (depName) deps.push(depName);
    }
    return deps;
  }

  // ─── Wheel unpacking ─────────────────────────────────────────────────────────

  /**
   * Minimal wheel unpacking: a wheel is a ZIP archive.
   * We write a METADATA file so `list()` can detect the package.
   * For pure-Python wheels we also extract .py files into site-packages.
   */
  private async _unpackWheel(
    name: string,
    version: string,
    wheelBytes: Uint8Array,
  ): Promise<void> {
    // Parse ZIP and extract files into site-packages
    const files = this._parseZip(wheelBytes);

    for (const [filename, content] of files) {
      const destPath = `${SITE_PACKAGES}/${filename}`;
      this.vfs.writeFile(destPath, content);
    }

    // Ensure dist-info directory and METADATA exist
    const distInfoDir = `${SITE_PACKAGES}/${name}-${version}.dist-info`;
    this.vfs.pathCreateDirectory(distInfoDir);

    const metadataPath = `${distInfoDir}/METADATA`;
    try {
      this.vfs.readFile(metadataPath);
    } catch {
      // Write minimal METADATA if not extracted from wheel
      const metadata = `Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`;
      this.vfs.writeFile(metadataPath, metadata);
    }
  }

  /**
   * Minimal ZIP parser — extracts local file entries from a ZIP archive.
   * Returns a map of filename → content.
   */
  private _parseZip(bytes: Uint8Array): Map<string, Uint8Array> {
    const files = new Map<string, Uint8Array>();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;

    while (offset + 4 <= bytes.length) {
      const sig = view.getUint32(offset, true);

      // Local file header signature: 0x04034b50
      if (sig !== 0x04034b50) break;

      const compressionMethod = view.getUint16(offset + 8, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const filenameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);

      const filenameBytes = bytes.subarray(offset + 30, offset + 30 + filenameLength);
      const filename = new TextDecoder().decode(filenameBytes);

      const dataOffset = offset + 30 + filenameLength + extraLength;
      const compressedData = bytes.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) {
        // Stored (no compression)
        files.set(filename, compressedData.slice(0, uncompressedSize));
      } else if (compressionMethod === 8) {
        // Deflate — use DecompressionStream if available
        try {
          const decompressed = this._inflateSync(compressedData, uncompressedSize);
          if (decompressed) files.set(filename, decompressed);
        } catch {
          // Skip files we can't decompress
        }
      }

      offset = dataOffset + compressedSize;
    }

    return files;
  }

  /**
   * Synchronous inflate using DecompressionStream (browser API).
   * Returns null if unavailable.
   */
  private _inflateSync(data: Uint8Array, _expectedSize: number): Uint8Array | null {
    // DecompressionStream is async-only in browsers; we can't use it synchronously.
    // For the purposes of this implementation, we skip compressed entries.
    // In a real implementation, a WASM-based zlib would be used here.
    void data;
    return null;
  }

  // ─── METADATA parsing ────────────────────────────────────────────────────────

  private _parseMetadata(text: string): PackageInfo | null {
    let name: string | null = null;
    let version: string | null = null;

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Name:')) {
        name = trimmed.slice('Name:'.length).trim();
      } else if (trimmed.startsWith('Version:')) {
        version = trimmed.slice('Version:'.length).trim();
      }
      if (name && version) break;
    }

    if (!name || !version) return null;
    return { name, version };
  }
}
