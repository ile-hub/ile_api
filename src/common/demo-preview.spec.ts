import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import {
  DemoPreviewService,
  validateDemoPreviewConfig,
  DEMO_WORKDIR,
  DEMO_PROJECT,
} from './demo-preview.service';
import { existsSync, readFileSync } from 'node:fs';
jest.mock('node:fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));
const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
const allowlist = actual.readFileSync(resolve('demo/preview-allowlist.json'));
const base = {
  LERI_DEMO_PREVIEW: 'true',
  NODE_ENV: 'test',
  E2E_ISOLATED_LOCAL: '1',
  LERI_SUPABASE_TEST_WORKDIR: DEMO_WORKDIR,
  SUPABASE_URL: 'http://127.0.0.1:55321',
  DATABASE_URL: 'postgresql://app_user:local@127.0.0.1:55322/postgres',
  LERI_DEMO_PREVIEW_ALLOWLIST: '/reviewed.json',
};
const config = (patch: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = { ...base, ...patch };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new Error('Missing ' + key);
      return values[key];
    },
  } as unknown as ConfigService;
};
beforeEach(() => {
  jest.mocked(existsSync).mockReturnValue(false);
  jest
    .mocked(readFileSync)
    .mockImplementation((path) =>
      path.toString().endsWith('config.toml')
        ? `project_id = "${DEMO_PROJECT}"`
        : allowlist,
    );
});
it('is off by default and with explicit false', () => {
  expect(
    validateDemoPreviewConfig(config({ LERI_DEMO_PREVIEW: undefined })),
  ).toBe(false);
  expect(
    validateDemoPreviewConfig(config({ LERI_DEMO_PREVIEW: 'false' })),
  ).toBe(false);
  expect(readFileSync).not.toHaveBeenCalled();
});
it('accepts only the exact isolated target and reviewed allowlist', () => {
  expect(validateDemoPreviewConfig(config())).toBe(true);
});
it.each([
  { NODE_ENV: 'production' },
  { NODE_ENV: 'staging' },
  { NODE_ENV: undefined },
  { E2E_ISOLATED_LOCAL: '0' },
  { LERI_SUPABASE_TEST_WORKDIR: '/tmp/other' },
  { SUPABASE_URL: 'https://remote.supabase.co' },
  { DATABASE_URL: 'postgresql://app_user:x@127.0.0.1:54322/postgres' },
  { DATABASE_URL: 'postgresql://app_user:x@remote:55322/postgres' },
  { DATABASE_URL: 'postgresql://postgres:x@127.0.0.1:55322/postgres' },
  {
    DATABASE_URL:
      'postgresql://app_user:x@127.0.0.1:55322/postgres?host=remote',
  },
  { LERI_DEMO_PREVIEW: 'yes' },
  { LERI_DEMO_PREVIEW_ALLOWLIST: undefined },
])('fails closed on %j', (patch) =>
  expect(() => validateDemoPreviewConfig(config(patch))).toThrow(),
);
it('rejects a linked project', () => {
  jest.mocked(existsSync).mockReturnValue(true);
  expect(() => validateDemoPreviewConfig(config())).toThrow();
});
it('rejects altered/missing project or allowlist files', () => {
  jest
    .mocked(readFileSync)
    .mockImplementation((path) =>
      path.toString().endsWith('config.toml')
        ? `project_id = "${DEMO_PROJECT}"`
        : '{}',
    );
  expect(() => validateDemoPreviewConfig(config())).toThrow('allowlist');
  jest.mocked(readFileSync).mockImplementation(() => {
    throw new Error('ENOENT');
  });
  expect(() => validateDemoPreviewConfig(config())).toThrow();
});

it('does not access SQL or activate preview in default configuration', async () => {
  const pool = { query: jest.fn() };
  const service = new DemoPreviewService(
    config({ LERI_DEMO_PREVIEW: undefined }),
    {} as never,
    pool as never,
  );
  await service.onModuleInit();
  expect(service.enabled).toBe(false);
  expect(pool.query).not.toHaveBeenCalled();
});
it('refuses startup when the installed SQL allowlist is absent or ownership validation fails', async () => {
  const pool = {
    query: jest
      .fn()
      .mockResolvedValue({ rows: [{ valid: false, manifest: {} }] }),
  };
  const service = new DemoPreviewService(config(), {} as never, pool as never);
  await expect(service.onModuleInit()).rejects.toThrow('allowlist');
  expect(service.enabled).toBe(false);
});
