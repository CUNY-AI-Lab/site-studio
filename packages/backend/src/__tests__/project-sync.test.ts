import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ProjectSyncService } from '../services/project-sync.js';
import type { IStorage, StorageFile } from '../storage/types.js';

function makeStorageFile(filePath: string): StorageFile {
  return {
    path: filePath,
    name: path.basename(filePath),
    size: 0,
    lastModified: new Date(),
    isDirectory: false,
  };
}

describe('ProjectSyncService', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'project-sync-test-'));
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('removes stale local files during hydration before downloading R2 state', async () => {
    await fs.writeFile(path.join(projectPath, 'stale.txt'), 'old local file', 'utf-8');
    await fs.mkdir(path.join(projectPath, 'nested'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'nested/ghost.txt'), 'ghost', 'utf-8');

    const storage = {
      listFiles: vi.fn().mockResolvedValue([makeStorageFile('index.html')]),
      readFileBuffer: vi.fn().mockResolvedValue(Buffer.from('<html>fresh</html>', 'utf-8')),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    const result = await syncService.hydrate('user-1', 'project-a', projectPath);

    await expect(fs.access(path.join(projectPath, 'stale.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(projectPath, 'nested/ghost.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(projectPath, 'index.html'), 'utf-8')).resolves.toBe('<html>fresh</html>');
    expect(result.filesDownloaded).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('does not mark hydration as complete when some files fail to download', async () => {
    const storage = {
      listFiles: vi.fn().mockResolvedValue([
        makeStorageFile('index.html'),
        makeStorageFile('broken.css'),
      ]),
      readFileBuffer: vi.fn(async (_userId: string, _projectId: string, filePath: string) => {
        if (filePath === 'broken.css') {
          throw new Error('download failed');
        }

        return Buffer.from('ok', 'utf-8');
      }),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    const result = await syncService.hydrate('user-1', 'project-a', projectPath);

    expect(result.filesDownloaded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect((syncService as any).lastSyncTime.has('user-1/project-a')).toBe(false);
  });

  it('skips sandbox-only artifact files during hydration', async () => {
    const storage = {
      listFiles: vi.fn().mockResolvedValue([
        makeStorageFile('index.html'),
        makeStorageFile('node_modules/pkg/index.js'),
        makeStorageFile('.svelte-kit/output/client.js'),
      ]),
      readFileBuffer: vi.fn().mockResolvedValue(Buffer.from('<html>fresh</html>', 'utf-8')),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    const result = await syncService.hydrate('user-1', 'project-a', projectPath);

    expect(result.filesDownloaded).toBe(1);
    expect(result.errors).toEqual([]);
    expect(storage.readFileBuffer).toHaveBeenCalledTimes(1);
    expect(storage.readFileBuffer).toHaveBeenCalledWith('user-1', 'project-a', 'index.html');
    await expect(fs.access(path.join(projectPath, 'node_modules/pkg/index.js'))).rejects.toThrow();
    await expect(fs.access(path.join(projectPath, '.svelte-kit/output/client.js'))).rejects.toThrow();
  });

  it('does not advance the sync baseline when uploads fail', async () => {
    await fs.writeFile(path.join(projectPath, 'index.html'), '<html>updated</html>', 'utf-8');

    const storage = {
      writeFile: vi.fn().mockRejectedValue(new Error('upload failed')),
      listFiles: vi.fn().mockResolvedValue([]),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    const result = await syncService.sync('user-1', 'project-a', projectPath);

    expect(result.filesUploaded).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect((syncService as any).lastSyncTime.has('user-1/project-a')).toBe(false);
  });

  it('uploads changed files even when the local mtime moves backwards', async () => {
    const storage = {
      listFiles: vi
        .fn()
        .mockResolvedValueOnce([makeStorageFile('index.html')])
        .mockResolvedValueOnce([makeStorageFile('index.html')]),
      readFileBuffer: vi.fn().mockResolvedValue(Buffer.from('<html>old</html>', 'utf-8')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    await syncService.hydrate('user-1', 'project-a', projectPath);

    const filePath = path.join(projectPath, 'index.html');
    const initialStat = await fs.stat(filePath);

    await fs.writeFile(filePath, '<html>new</html>', 'utf-8');
    const earlier = new Date(initialStat.mtimeMs - 1000);
    await fs.utimes(filePath, earlier, earlier);

    const result = await syncService.sync('user-1', 'project-a', projectPath);

    expect(result.errors).toEqual([]);
    expect(result.filesUploaded).toBe(1);
    expect(storage.writeFile).toHaveBeenCalledWith(
      'user-1',
      'project-a',
      'index.html',
      expect.any(Buffer)
    );
  });

  it('does not treat dotfiles that still exist locally as deletions', async () => {
    await fs.writeFile(path.join(projectPath, '.nojekyll'), '', 'utf-8');

    const storage = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([makeStorageFile('.nojekyll')]),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    const result = await syncService.sync('user-1', 'project-a', projectPath);

    expect(result.errors).toEqual([]);
    expect(storage.deleteFile).not.toHaveBeenCalled();
    expect(storage.writeFile).toHaveBeenCalledWith(
      'user-1',
      'project-a',
      '.nojekyll',
      expect.any(Buffer)
    );
  });

  it('ignores sandbox-only build artifacts during sync and cleans them out of R2', async () => {
    await fs.writeFile(path.join(projectPath, 'index.html'), '<html>site</html>', 'utf-8');
    await fs.mkdir(path.join(projectPath, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'node_modules/pkg/index.js'), 'module.exports = {};', 'utf-8');
    await fs.mkdir(path.join(projectPath, '.svelte-kit/output'), { recursive: true });
    await fs.writeFile(path.join(projectPath, '.svelte-kit/output/client.js'), 'artifact', 'utf-8');

    const storage = {
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([
        makeStorageFile('index.html'),
        makeStorageFile('node_modules/pkg/index.js'),
        makeStorageFile('.svelte-kit/output/client.js'),
      ]),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    const result = await syncService.sync('user-1', 'project-a', projectPath);

    expect(result.errors).toEqual([]);
    expect(storage.writeFile).toHaveBeenCalledTimes(1);
    expect(storage.writeFile).toHaveBeenCalledWith(
      'user-1',
      'project-a',
      'index.html',
      expect.any(Buffer)
    );
    expect(storage.deleteFile).toHaveBeenCalledTimes(2);
    expect(storage.deleteFile).toHaveBeenCalledWith('user-1', 'project-a', 'node_modules/pkg/index.js');
    expect(storage.deleteFile).toHaveBeenCalledWith('user-1', 'project-a', '.svelte-kit/output/client.js');
  });

  it('fullSync uploads unchanged files by clearing the previous content-hash baseline', async () => {
    const storage = {
      listFiles: vi
        .fn()
        .mockResolvedValueOnce([makeStorageFile('index.html')])
        .mockResolvedValueOnce([makeStorageFile('index.html')]),
      readFileBuffer: vi.fn().mockResolvedValue(Buffer.from('<html>same</html>', 'utf-8')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    } as Partial<IStorage> as IStorage;

    const syncService = new ProjectSyncService(storage);
    await syncService.hydrate('user-1', 'project-a', projectPath);

    const result = await syncService.fullSync('user-1', 'project-a', projectPath);

    expect(result.errors).toEqual([]);
    expect(result.filesUploaded).toBe(1);
    expect(storage.writeFile).toHaveBeenCalledWith(
      'user-1',
      'project-a',
      'index.html',
      expect.any(Buffer)
    );
  });
});
