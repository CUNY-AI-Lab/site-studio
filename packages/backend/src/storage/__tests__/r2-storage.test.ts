import { describe, expect, it, vi } from 'vitest';
import { R2Storage } from '../r2-storage.js';

function createStorage() {
  return new R2Storage('account-id', 'access-key', 'secret-key', 'bucket-name');
}

describe('R2Storage', () => {
  it('paginates file listings and scopes them to the exact project prefix', async () => {
    const storage = createStorage();
    const send = vi.fn(async (command: any) => {
      expect(command.input.Prefix).toBe('projects/user-1/project-a/');

      if (!command.input.ContinuationToken) {
        return {
          Contents: [
            {
              Key: 'projects/user-1/project-a/index.html',
              Size: 12,
              LastModified: new Date('2026-01-01T00:00:00Z'),
            },
          ],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        };
      }

      expect(command.input.ContinuationToken).toBe('page-2');
      return {
        Contents: [
          {
            Key: 'projects/user-1/project-a/assets/logo.png',
            Size: 5,
            LastModified: new Date('2026-01-02T00:00:00Z'),
          },
          {
            Key: 'projects/user-1/project-a/.metadata.json',
            Size: 99,
            LastModified: new Date('2026-01-03T00:00:00Z'),
          },
        ],
        IsTruncated: false,
      };
    });

    (storage as any).client = { send };

    const files = await storage.listFiles('user-1', 'project-a');

    expect(send).toHaveBeenCalledTimes(2);
    expect(files.map(file => file.path)).toEqual([
      'index.html',
      'assets/logo.png',
    ]);
  });

  it('paginates project listings across multiple pages', async () => {
    const storage = createStorage();
    const send = vi.fn(async (command: any) => {
      expect(command.input.Prefix).toBe('projects/user-1/');
      expect(command.input.Delimiter).toBe('/');

      if (!command.input.ContinuationToken) {
        return {
          CommonPrefixes: [
            { Prefix: 'projects/user-1/project-a/' },
            { Prefix: 'projects/user-1/project-b/' },
          ],
          IsTruncated: true,
          NextContinuationToken: 'page-2',
        };
      }

      expect(command.input.ContinuationToken).toBe('page-2');
      return {
        CommonPrefixes: [
          { Prefix: 'projects/user-1/project-c/' },
          { Prefix: 'projects/user-1/project-b/' },
        ],
        IsTruncated: false,
      };
    });

    (storage as any).client = { send };

    const projects = await storage.listProjects('user-1');

    expect(projects).toEqual(['project-a', 'project-b', 'project-c']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('paginates user-prefix discovery when finding a project owner', async () => {
    const storage = createStorage();
    const send = vi.fn(async (command: any) => {
      if (command.input.Prefix === 'projects/') {
        expect(command.input.Delimiter).toBe('/');

        if (!command.input.ContinuationToken) {
          return {
            CommonPrefixes: [{ Prefix: 'projects/user-1/' }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          };
        }

        expect(command.input.ContinuationToken).toBe('page-2');
        return {
          CommonPrefixes: [{ Prefix: 'projects/user-2/' }],
          IsTruncated: false,
        };
      }

      if (command.input.Key === 'projects/user-1/project-a/.metadata.json') {
        const error = new Error('Not found') as Error & { name: string };
        error.name = 'NotFound';
        throw error;
      }

      if (command.input.Key === 'projects/user-2/project-a/.metadata.json') {
        return {};
      }

      throw new Error(`Unexpected command: ${JSON.stringify(command.input)}`);
    });

    (storage as any).client = { send };

    const owner = await storage.findProjectOwner('project-a');

    expect(owner).toBe('user-2');
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('deletes all project objects before surfacing aggregated deletion errors', async () => {
    const storage = createStorage();
    vi.spyOn(storage, 'listFiles').mockResolvedValue([
      {
        path: 'index.html',
        name: 'index.html',
        size: 10,
        lastModified: new Date(),
        isDirectory: false,
      },
      {
        path: 'styles.css',
        name: 'styles.css',
        size: 5,
        lastModified: new Date(),
        isDirectory: false,
      },
    ]);

    const send = vi.fn(async (command: any) => {
      if (command.input.Key === 'projects/user-1/project-a/index.html') {
        throw new Error('delete failed');
      }

      return {};
    });

    (storage as any).client = { send };

    await expect(storage.deleteProject('user-1', 'project-a')).rejects.toThrow(
      'Failed to delete project project-a'
    );

    const deletedKeys = send.mock.calls.map(([command]) => command.input.Key);
    expect(deletedKeys).toEqual([
      'projects/user-1/project-a/index.html',
      'projects/user-1/project-a/styles.css',
      'projects/user-1/project-a/.metadata.json',
    ]);
  });

  it('rolls back newly copied objects when rename fails before source cleanup starts', async () => {
    const storage = createStorage();
    vi.spyOn(storage, 'listFiles').mockResolvedValue([
      {
        path: 'index.html',
        name: 'index.html',
        size: 10,
        lastModified: new Date(),
        isDirectory: false,
      },
      {
        path: 'styles.css',
        name: 'styles.css',
        size: 5,
        lastModified: new Date(),
        isDirectory: false,
      },
    ]);
    vi.spyOn(storage, 'getProjectMetadata').mockResolvedValue({
      id: 'project-a',
      name: 'Project A',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      published: false,
    });

    const send = vi.fn(async (command: any) => {
      if (command.constructor.name === 'CopyObjectCommand') {
        if (command.input.Key === 'projects/user-1/project-b/index.html') {
          return {};
        }

        if (command.input.Key === 'projects/user-1/project-b/styles.css') {
          throw new Error('copy failed');
        }
      }

      if (command.constructor.name === 'DeleteObjectCommand') {
        return {};
      }

      throw new Error(`Unexpected command: ${command.constructor.name}`);
    });

    (storage as any).client = { send };

    await expect(storage.renameProject('user-1', 'project-a', 'project-b')).rejects.toThrow('copy failed');

    const deleteKeys = send.mock.calls
      .filter(([command]) => command.constructor.name === 'DeleteObjectCommand')
      .map(([command]) => command.input.Key);

    expect(deleteKeys).toEqual([
      'projects/user-1/project-b/index.html',
    ]);
  });

  it('keeps the new project copy when old-project cleanup fails during rename', async () => {
    const storage = createStorage();
    const listFiles = vi.spyOn(storage, 'listFiles');
    listFiles
      .mockResolvedValueOnce([
        {
          path: 'index.html',
          name: 'index.html',
          size: 10,
          lastModified: new Date(),
          isDirectory: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          path: 'index.html',
          name: 'index.html',
          size: 10,
          lastModified: new Date(),
          isDirectory: false,
        },
      ]);

    vi.spyOn(storage, 'getProjectMetadata').mockResolvedValue({
      id: 'project-a',
      name: 'Project A',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      published: false,
    });
    vi.spyOn(storage, 'updateProjectMetadata').mockResolvedValue(undefined);

    const send = vi.fn(async (command: any) => {
      if (command.constructor.name === 'CopyObjectCommand') {
        return {};
      }

      if (command.constructor.name === 'DeleteObjectCommand') {
        if (command.input.Key === 'projects/user-1/project-a/index.html') {
          throw new Error('old delete failed');
        }

        return {};
      }

      throw new Error(`Unexpected command: ${command.constructor.name}`);
    });

    (storage as any).client = { send };

    await expect(storage.renameProject('user-1', 'project-a', 'project-b')).rejects.toThrow(
      'Project files were copied to project-b, but cleanup of project-a failed'
    );

    const rollbackDeleteKeys = send.mock.calls
      .filter(([command]) =>
        command.constructor.name === 'DeleteObjectCommand' &&
        command.input.Key.startsWith('projects/user-1/project-b/')
      )
      .map(([command]) => command.input.Key);

    expect(rollbackDeleteKeys).toEqual([]);
  });
});
