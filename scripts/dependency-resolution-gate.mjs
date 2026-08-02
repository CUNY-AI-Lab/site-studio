import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Bun's text lockfile is JSON with trailing commas. Keep this parser deliberately
// small and string-aware so this gate never needs a package install or network call.
export function parseBunLock(text) {
  let output = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];
    if (inLineComment) {
      if (character === '\n') {
        inLineComment = false;
        output += character;
      }
      continue;
    }
    if (inBlockComment) {
      if (character === '*' && nextCharacter === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }

    if (character === '/' && nextCharacter === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (character === ',') {
      let next = index + 1;
      while (next < text.length) {
        while (/\s/.test(text[next] ?? '')) next += 1;
        if (text.startsWith('//', next)) {
          const newline = text.indexOf('\n', next + 2);
          next = newline === -1 ? text.length : newline + 1;
          continue;
        }
        if (text.startsWith('/*', next)) {
          const endComment = text.indexOf('*/', next + 2);
          next = endComment === -1 ? text.length : endComment + 2;
          continue;
        }
        break;
      }
      if (text[next] === '}' || text[next] === ']') continue;
    }
    output += character;
  }

  return JSON.parse(output);
}

function readBunLock(rootDir) {
  const lockPath = path.join(rootDir, 'bun.lock');
  if (!fs.existsSync(lockPath)) throw new Error('bun.lock is missing');
  return parseBunLock(fs.readFileSync(lockPath, 'utf8'));
}

function isValidPackageName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 214) return false;
  if (name.trim() !== name || name.startsWith('.') || name.startsWith('-') || name.startsWith('_')) return false;
  if (name.toLowerCase() !== name || /[\u0000-\u001f\u007f]/.test(name)) return false;
  if (name === 'node_modules' || name === 'favicon.ico') return false;

  const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
  if (!scoped && name.includes('/')) return false;
  const scope = scoped?.[1];
  const packageName = scoped?.[2] ?? name;
  if (packageName.startsWith('.')) return false;
  if (/[~'!()*]/.test(packageName)) return false;
  if (scoped && (!scope || encodeURIComponent(scope) !== scope || encodeURIComponent(packageName) !== packageName)) return false;
  return !scoped ? encodeURIComponent(name) === name : true;
}

function dependencyMap(manifest, invalidNames = new Set()) {
  const result = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
      if (!isValidPackageName(name)) {
        invalidNames.add(name);
        continue;
      }
      result.set(name, spec);
    }
  }
  return result;
}

function hasGlob(segment) {
  return segment.includes('*') || segment.includes('?') || segment.includes('[');
}

function matchSegment(segment, value) {
  if (!hasGlob(segment)) return segment === value;
  const escaped = segment
    .replace(/[.+^${}()|\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function realpathSafe(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function pathInside(rootDirectory, candidate) {
  const relative = path.relative(rootDirectory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function workspaceChildren(rootRealPath, directory) {
  const children = [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return children;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const candidate = path.join(directory, entry.name);
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const realPath = realpathSafe(candidate);
    if (!realPath || !pathInside(rootRealPath, realPath)) continue;
    children.push({ path: candidate, realPath });
  }
  return children;
}

function expandWorkspacePattern(rootDir, rootRealPath, pattern) {
  if (path.isAbsolute(pattern)) return [];
  const segments = pattern.replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(Boolean);
  const matches = [];
  const visited = new Set();

  function walk(directory, realDirectory, segmentIndex) {
    const visitKey = `${realDirectory}:${segmentIndex}`;
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    if (segmentIndex === segments.length) {
      const manifestPath = path.join(directory, 'package.json');
      const manifestRealPath = realpathSafe(manifestPath);
      if (manifestRealPath && pathInside(rootRealPath, manifestRealPath)) {
        matches.push({ path: directory, realPath: realDirectory });
      }
      return;
    }

    const segment = segments[segmentIndex];
    if (segment === '**') {
      walk(directory, realDirectory, segmentIndex + 1);
      for (const child of workspaceChildren(rootRealPath, directory)) walk(child.path, child.realPath, segmentIndex);
      return;
    }

    for (const child of workspaceChildren(rootRealPath, directory)) {
      if (matchSegment(segment, path.basename(child.path))) walk(child.path, child.realPath, segmentIndex + 1);
    }
  }

  const rootReal = realpathSafe(rootDir);
  if (!rootReal) return matches;
  walk(rootDir, rootReal, 0);
  return matches;
}

function workspacePatterns(rootManifest) {
  if (Array.isArray(rootManifest.workspaces)) return rootManifest.workspaces;
  if (rootManifest.workspaces && Array.isArray(rootManifest.workspaces.packages)) {
    return rootManifest.workspaces.packages;
  }
  return [];
}

function discoverWorkspaces(rootDir, rootManifest, issues) {
  const rootRealPath = realpathSafe(rootDir);
  if (!rootRealPath) {
    issues.push('project root cannot be resolved safely');
    return [{ key: '', canonicalKey: '', directory: rootDir, realDirectory: rootDir, manifest: rootManifest }];
  }
  const selected = new Map();
  for (const rawPattern of workspacePatterns(rootManifest)) {
    if (typeof rawPattern !== 'string' || rawPattern.length === 0) continue;
    const negative = rawPattern.startsWith('!');
    const pattern = negative ? rawPattern.slice(1) : rawPattern;
    if (pattern.includes('..')) {
      issues.push('workspace glob escapes the project root');
      continue;
    }
    for (const match of expandWorkspacePattern(rootDir, rootRealPath, pattern)) {
      if (negative) selected.delete(match.realPath);
      else selected.set(match.realPath, match);
    }
  }

  const workspaces = [{ key: '', canonicalKey: '', directory: rootDir, realDirectory: rootRealPath, manifest: rootManifest }];
  for (const { path: directory, realPath } of selected.values()) {
    const manifestPath = path.join(directory, 'package.json');
    const workspaceKey = path.relative(rootDir, directory).replaceAll(path.sep, '/');
    if (!workspaceKey || !pathInside(rootRealPath, realPath)) continue;
    if (workspaces.some((workspace) => workspace.realDirectory === realPath)) continue;
    try {
      workspaces.push({
        key: workspaceKey,
        canonicalKey: path.relative(rootRealPath, realPath).replaceAll(path.sep, '/'),
        directory,
        realDirectory: realPath,
        manifest: readJson(manifestPath),
      });
    } catch {
      issues.push(`workspace ${workspaceKey} has an unreadable package.json`);
    }
  }
  return workspaces;
}

function lockWorkspace(lock, key) {
  const workspaces = lock.workspaces ?? {};
  return workspaces[key] ?? workspaces[key ? `./${key}` : '.'] ?? undefined;
}

function descriptorNameVersion(descriptor) {
  if (typeof descriptor !== 'string') return null;
  const at = descriptor.startsWith('@') ? descriptor.indexOf('@', 1) : descriptor.indexOf('@');
  if (at <= 0 || at === descriptor.length - 1) return null;
  return { name: descriptor.slice(0, at), version: descriptor.slice(at + 1) };
}

function normalizedVersion(value) {
  if (typeof value !== 'string') return undefined;
  return semver.valid(value) ?? undefined;
}

function satisfiesVersionRange(version, range) {
  const normalized = normalizedVersion(version);
  const validRange = typeof range === 'string' ? semver.validRange(range) : null;
  return Boolean(normalized && validRange !== null && semver.satisfies(normalized, validRange));
}

function isSourceForm(value) {
  return typeof value === 'string' && /^(?:[a-z][a-z\d+.-]*:|git@|\/\/)/i.test(value);
}

function normalizeUrlVersion(packageName, value) {
  if (typeof value !== 'string' || !/^(?:https?:|\/\/)/i.test(value)) return undefined;
  const packageBase = packageName.split('/').at(-1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[/_-])${packageBase}[-@](v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)(?:\\.tgz|\\.tar\\.gz)?(?:$|[/?#])`, 'i').exec(value)?.[1];
}

function isVersionForm(value) {
  return typeof value === 'string' && !isSourceForm(value) && semver.validRange(value) !== null;
}

function sourceProtocol(value) {
  if (typeof value !== 'string') return undefined;
  if (value.startsWith('//')) return 'https';
  if (value.startsWith('git@')) return 'git';
  return /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1].toLowerCase();
}

function immutableGitCommit(value) {
  return /#([0-9a-f]{40})$/i.exec(value)?.[1].toLowerCase();
}

function isHttpsTarball(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    return url.protocol === 'https:' && /\.(?:tgz|tar\.gz)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function sourceKind(value, packageName) {
  const protocol = sourceProtocol(value);
  if (protocol === 'https') {
    return isHttpsTarball(value) && normalizeUrlVersion(packageName, value)
      ? { kind: 'https-tarball' }
      : { error: 'HTTPS download URL has no derivable package version' };
  }
  if (protocol === 'git' || protocol === 'git+ssh' || protocol === 'git+https' || protocol === 'ssh' || protocol === 'github' || protocol === 'gitlab' || protocol === 'bitbucket') {
    return immutableGitCommit(value) ? { kind: 'immutable-git' } : { error: 'Git source is not pinned to an immutable commit' };
  }
  return { error: 'dependency source form is not supported' };
}

function parseNpmAlias(spec) {
  const target = spec.slice(4);
  const at = target.startsWith('@') ? target.indexOf('@', 1) : target.indexOf('@');
  if (at <= 0) return { targetName: target, targetSpec: undefined };
  return { targetName: target.slice(0, at), targetSpec: target.slice(at + 1) };
}

function dependencySpecInfo(name, spec) {
  if (typeof spec !== 'string') return { kind: 'unsupported' };
  if (spec.startsWith('workspace:')) return { kind: 'workspace', protocol: spec.slice('workspace:'.length) };
  if (spec.startsWith('npm:')) {
    const alias = parseNpmAlias(spec);
    if (!isValidPackageName(alias.targetName)) return { kind: 'unsupported' };
    return { kind: 'alias', ...alias };
  }
  if (isSourceForm(spec)) return { kind: 'source', source: spec };
  return { kind: 'version', requested: spec, name };
}

function formatSpec(spec) {
  if (typeof spec !== 'string') return '<missing>';
  return isVersionForm(spec) ? spec : '<dependency source>';
}

function relativePath(rootDir, filePath) {
  return path.relative(rootDir, filePath).replaceAll(path.sep, '/') || '.';
}

function lockRecords(lock) {
  const records = [];
  for (const [key, value] of Object.entries(lock.packages ?? {})) {
    if (!Array.isArray(value) || typeof value[0] !== 'string') continue;
    const descriptor = descriptorNameVersion(value[0]);
    if (!descriptor) continue;
    if (!isValidPackageName(descriptor.name)) continue;
    records.push({
      key,
      descriptorName: descriptor.name,
      rawVersion: descriptor.version,
      source: typeof value[1] === 'string' ? value[1] : undefined,
      integrity: typeof value[3] === 'string' ? value[3] : undefined,
    });
  }
  return records;
}

function recordVersion(record, packageName, specInfo) {
  const candidates = [record.rawVersion, record.source];
  if (specInfo.kind === 'alias') candidates.push(specInfo.targetSpec);
  for (const candidate of candidates) {
    const exact = normalizedVersion(candidate);
    if (exact) return exact;
    if (isSourceForm(candidate)) {
      const urlVersion = normalizeUrlVersion(packageName, candidate);
      const normalized = normalizedVersion(urlVersion);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function isWorkspaceScopedRecord(record, workspaceKeys) {
  return workspaceKeys.some((workspaceKey) => workspaceKey && record.key.startsWith(`${workspaceKey}/`));
}

function recordsForDependency(records, workspaceKey, dependencyName, specInfo, workspaceKeys) {
  const names = new Set([dependencyName]);
  if (specInfo.targetName) names.add(specInfo.targetName);
  const sourceMatches = specInfo.source
    ? records.filter((record) => record.source === specInfo.source || record.rawVersion === specInfo.source)
    : [];
  const root = records.filter(
    (record) => !isWorkspaceScopedRecord(record, workspaceKeys) && (names.has(record.key) || sourceMatches.includes(record)),
  );
  const scoped = workspaceKey
    ? records.filter((record) => {
        const prefix = `${workspaceKey}/`;
        if (!record.key.startsWith(prefix)) return false;
        const tail = record.key.slice(prefix.length).replace(/^node_modules\//, '');
        return names.has(tail) || sourceMatches.includes(record);
      })
    : [];
  const rootExact = records.filter(
    (record) => !isWorkspaceScopedRecord(record, workspaceKeys) && record.key === dependencyName,
  );
  const scopedExact = workspaceKey
    ? records.filter((record) => record.key === `${workspaceKey}/${dependencyName}` || record.key === `${workspaceKey}/node_modules/${dependencyName}`)
    : [];
  return { root, scoped, rootExact, scopedExact };
}

function expectedRecord(records, workspace, dependencyName, specInfo, workspaceKeys) {
  const { root, scoped, rootExact, scopedExact } = recordsForDependency(records, workspace.key, dependencyName, specInfo, workspaceKeys);
  if (scopedExact.length > 1) return { error: 'multiple workspace-specific importer lock records' };
  if (rootExact.length > 1) return { error: 'multiple root importer lock records' };
  if (scopedExact.length === 1) return { record: scopedExact[0], location: 'workspace' };
  if (rootExact.length === 1) return { record: rootExact[0], location: 'root' };
  if (scoped.length > 1) return { error: 'multiple workspace-specific lock records' };
  if (root.length > 1) return { error: 'multiple root lock records' };
  if (scoped.length === 1) return { record: scoped[0], location: 'workspace' };
  if (root.length === 1) return { record: root[0], location: 'root' };

  const names = new Set([dependencyName]);
  if (specInfo.targetName) names.add(specInfo.targetName);
  const descriptorMatches = records.filter(
    (record) => names.has(record.descriptorName) && !isWorkspaceScopedRecord(record, workspaceKeys),
  );
  if (descriptorMatches.length === 1) return { record: descriptorMatches[0], location: 'root' };
  return { error: 'no unambiguous importer-to-package lock record' };
}

function packageDirectoryFromResolved(rootDir, resolvedPath) {
  let directory = path.dirname(resolvedPath);
  const stop = path.dirname(rootDir);
  while (directory !== stop) {
    const packagePath = path.join(directory, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const manifest = readJson(packagePath);
        if (typeof manifest.name === 'string') return { directory, manifest };
      } catch {
        return null;
      }
    }
    directory = path.dirname(directory);
  }
  return null;
}

function packageDirectoryFromWorkspaceNodeModules(rootDir, workspaceDirectory, name) {
  let directory = path.resolve(workspaceDirectory);
  const stop = path.dirname(rootDir);
  while (directory !== stop) {
    const packageDirectory = path.join(directory, 'node_modules', ...name.split('/'));
    const packagePath = path.join(packageDirectory, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const manifest = readJson(packagePath);
        if (typeof manifest.name === 'string') return { directory: packageDirectory, manifest };
      } catch {
        return null;
      }
    }
    directory = path.dirname(directory);
  }
  return null;
}

function resolveInstalledPackage(rootDir, workspace, name) {
  const requireFromWorkspace = createRequire(path.join(workspace.directory, 'package.json'));
  let resolvedPath;
  try {
    resolvedPath = requireFromWorkspace.resolve(name);
  } catch {
    try {
      resolvedPath = requireFromWorkspace.resolve(`${name}/package.json`);
    } catch {
      resolvedPath = null;
    }
  }
  return (
    (resolvedPath ? packageDirectoryFromResolved(rootDir, resolvedPath) : null) ??
    packageDirectoryFromWorkspaceNodeModules(rootDir, workspace.directory, name)
  );
}

function workspaceTarget(workspaces, dependencyName) {
  return workspaces.find((workspace) => workspace.manifest.name === dependencyName);
}

function expectedSelection(workspace, dependencyName, spec, records, workspaces, workspaceKeys) {
  const info = dependencySpecInfo(dependencyName, spec);
  if (info.kind === 'unsupported') return { error: 'unsupported dependency spec' };
  if (info.kind === 'workspace') {
    const target = workspaceTarget(workspaces, dependencyName);
    if (!target) return { error: 'workspace protocol target is not a discovered workspace' };
    const record = expectedRecord(records, workspace, dependencyName, { targetName: dependencyName }, workspaceKeys);
    if (record.error) return record;
    const expectedWorkspacePath = target.canonicalKey ? `workspace:${target.canonicalKey}` : 'workspace:';
    if (
      record.record.key !== target.manifest.name ||
      record.record.descriptorName !== target.manifest.name ||
      record.record.rawVersion !== expectedWorkspacePath
    ) {
      return { error: 'workspace protocol lock identity does not match the discovered target' };
    }
    return {
      ...record,
      location: 'workspace-target',
      target,
      expectedName: target.manifest.name,
      expectedVersion: target.manifest.version,
    };
  }

  const record = expectedRecord(records, workspace, dependencyName, info, workspaceKeys);
  if (record.error) return record;
  const expectedName = info.kind === 'alias' && info.targetName ? info.targetName : record.record.descriptorName || dependencyName;
  const expectedVersion = recordVersion(record.record, expectedName, info);
  if (record.record.rawVersion.startsWith('workspace:')) return { error: 'non-workspace dependency points to a workspace lock identity' };
  if (info.kind === 'alias') {
    if (record.record.descriptorName !== info.targetName) return { error: 'npm alias lock identity does not match its target' };
    if (typeof info.targetSpec !== 'string' || info.targetSpec.length === 0 || semver.validRange(info.targetSpec) === null) {
      return { error: 'npm alias target is not a valid semver range' };
    }
    if (!expectedVersion) return { error: 'locked package version is opaque' };
    if (!satisfiesVersionRange(expectedVersion, info.targetSpec)) {
      return { error: 'npm alias target range does not satisfy the lock resolution' };
    }
  }
  if (info.kind === 'version') {
    if (semver.validRange(info.requested) === null) return { error: 'dependency spec is not a valid semver range' };
    if (!expectedVersion) return { error: 'locked package version is opaque' };
    if (!satisfiesVersionRange(expectedVersion, info.requested)) {
      return { error: 'locked package version does not satisfy requested range' };
    }
  }
  if (info.kind === 'source') {
    const source = sourceKind(info.source, expectedName);
    if (source.error) return { error: source.error };
    if (record.record.rawVersion !== info.source && record.record.source !== info.source) {
      return { error: 'dependency source lock identity is not bound to the importer source' };
    }
    if (source.kind === 'https-tarball' && !expectedVersion) {
      return { error: 'HTTPS download URL lock identity has no derivable version' };
    }
  }
  return { ...record, expectedName, expectedVersion };
}

function expectedInstallPaths(rootRealPath, workspace, selection, dependencyName) {
  if (selection.location === 'workspace-target') {
    return { directory: selection.target.realDirectory, installRoot: null, isolatedRoots: [] };
  }
  const baseDirectory = selection.location === 'workspace' ? workspace.realDirectory : rootRealPath;
  const installRoot = path.join(baseDirectory, 'node_modules');
  const isolatedRoots = [path.join(installRoot, '.bun')];
  if (selection.location === 'workspace') isolatedRoots.push(path.join(rootRealPath, 'node_modules', '.bun'));
  return { directory: path.join(installRoot, ...dependencyName.split('/')), installRoot, isolatedRoots };
}

function pathInsideAny(candidate, roots) {
  return roots.some((root) => pathInside(root, candidate));
}

function checkResolvedDependency(rootDir, workspace, dependencyName, spec, records, workspaces, workspaceKeys, issues) {
  const selection = expectedSelection(workspace, dependencyName, spec, records, workspaces, workspaceKeys);
  if (selection.error) {
    issues.push(`${workspace.key || '.'} dependency ${dependencyName} has unsupported lock resolution (${selection.error})`);
    return;
  }
  const resolvedPackage = resolveInstalledPackage(rootDir, workspace, dependencyName);
  if (!resolvedPackage) {
    issues.push(`${workspace.key || '.'} cannot resolve ${dependencyName} from its workspace cwd`);
    return;
  }

  const actualDirectory = realpathSafe(resolvedPackage.directory);
  const rootRealPath = realpathSafe(rootDir);
  const { directory: expectedDirectory, installRoot, isolatedRoots } = expectedInstallPaths(rootRealPath ?? rootDir, workspace, selection, dependencyName);
  const expectedRealDirectory = realpathSafe(expectedDirectory);
  if (selection.location === 'workspace-target') {
    if (!rootRealPath || !actualDirectory || !pathInside(rootRealPath, actualDirectory) || actualDirectory !== expectedRealDirectory) {
      issues.push(
        `${workspace.key || '.'} resolves ${dependencyName} from ${relativePath(rootDir, resolvedPackage.directory)}; ` +
          `bun.lock selects a different workspace target path`,
      );
    }
  } else {
    const expectedInstallRoot = installRoot ? realpathSafe(installRoot) : null;
    const actualInIsolatedInstall = actualDirectory && pathInsideAny(actualDirectory, isolatedRoots);
    if (!expectedRealDirectory && !actualInIsolatedInstall) {
      issues.push(`${workspace.key || '.'} expected ${dependencyName} at its locked ${selection.location} install path, but that path is missing`);
    } else if (!rootRealPath || !expectedInstallRoot || !pathInside(rootRealPath, expectedInstallRoot) || !actualDirectory || !pathInside(rootRealPath, actualDirectory)) {
      issues.push(`${workspace.key || '.'} resolves ${dependencyName} outside the accepted repository install root`);
    } else if ((!pathInside(expectedInstallRoot, actualDirectory) && !actualInIsolatedInstall) || (!actualInIsolatedInstall && actualDirectory !== expectedRealDirectory)) {
      issues.push(
        `${workspace.key || '.'} resolves ${dependencyName} from ${relativePath(rootDir, resolvedPackage.directory)}; ` +
          `bun.lock selects a different ${selection.location} install path`,
      );
    }
  }
  if (selection.expectedName && resolvedPackage.manifest.name !== selection.expectedName) {
    issues.push(
      `${workspace.key || '.'} resolves ${dependencyName} as ${resolvedPackage.manifest.name}; ` +
        `bun.lock selects package identity ${selection.expectedName}`,
    );
  }
  if (selection.expectedVersion && resolvedPackage.manifest.version !== selection.expectedVersion) {
    issues.push(
      `${workspace.key || '.'} resolves ${dependencyName}@${resolvedPackage.manifest.version ?? 'unknown'}; ` +
        `bun.lock selects ${selection.expectedName}@${selection.expectedVersion}`,
    );
  }
}

function compareManifestToLock(workspace, lock, issues) {
  const invalidManifestNames = new Set();
  const manifestDependencies = dependencyMap(workspace.manifest, invalidManifestNames);
  invalidManifestNames.forEach(() => issues.push(`${workspace.key || '.'} declares invalid dependency name`));
  const importer = lockWorkspace(lock, workspace.key);
  if (!importer) {
    issues.push(`${workspace.key || '.'} has no matching bun.lock workspace importer`);
    return manifestDependencies;
  }

  if (typeof importer.name === 'string' && importer.name !== workspace.manifest.name) {
    issues.push(`${workspace.key || '.'} bun.lock importer has a different workspace package name`);
  }
  if (typeof importer.version === 'string' && importer.version !== workspace.manifest.version) {
    issues.push(`${workspace.key || '.'} bun.lock importer has a different workspace package version`);
  }

  const invalidLockedNames = new Set();
  const lockedDependencies = dependencyMap(importer, invalidLockedNames);
  invalidLockedNames.forEach(() => issues.push(`${workspace.key || '.'} bun.lock importer has invalid dependency name`));
  for (const [name, spec] of manifestDependencies) {
    if (!lockedDependencies.has(name)) {
      issues.push(`${workspace.key || '.'} declares ${name}, but its bun.lock importer does not`);
    } else if (lockedDependencies.get(name) !== spec) {
      issues.push(
        `${workspace.key || '.'} declares ${name}@${formatSpec(spec)}, but bun.lock records ${name}@${formatSpec(lockedDependencies.get(name))}`,
      );
    }
  }
  for (const name of lockedDependencies.keys()) {
    if (!manifestDependencies.has(name)) issues.push(`${workspace.key || '.'} bun.lock importer has stale dependency ${name}`);
  }
  return manifestDependencies;
}

export function verifyDependencyResolution({ rootDir = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const issues = [];
  let rootManifest;
  let lock;
  try {
    rootManifest = readJson(path.join(resolvedRoot, 'package.json'));
    lock = readBunLock(resolvedRoot);
  } catch (error) {
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)], checked: 0, workspaces: 0 };
  }

  const workspaces = discoverWorkspaces(resolvedRoot, rootManifest, issues);
  const records = lockRecords(lock);
  const workspaceKeys = workspaces.map((workspace) => workspace.key);
  const workspaceDependencyChecks = [];
  for (const workspace of workspaces) {
    const directDependencies = compareManifestToLock(workspace, lock, issues);
    workspaceDependencyChecks.push({ workspace, directDependencies });
  }

  const checks = [];
  for (const { workspace, directDependencies } of workspaceDependencyChecks) {
    for (const [name, spec] of directDependencies) {
      checks.push({ workspace: workspace.key, name });
      checkResolvedDependency(resolvedRoot, workspace, name, spec, records, workspaces, workspaceKeys, issues);
    }
  }

  return { ok: issues.length === 0, issues, checked: checks.length, workspaces: workspaces.length };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const result = verifyDependencyResolution();
  if (!result.ok) {
    console.error('Dependency resolution gate failed:');
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`Dependency resolution gate passed (${result.checked} direct dependencies across ${result.workspaces} workspaces).`);
  }
}
