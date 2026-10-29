// Which store getStore() picks (feature 6e). Local unless both Supabase server settings are set; SHORTLIST_DATA_DIR
// (tests' temp folders) always means local. Creating the Supabase store makes no network call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStore, SupabaseStore, getStore, localDataDir, storeKind } from '@/lib/storage';

const NAMES = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SHORTLIST_DATA_DIR'] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;

beforeEach(() => {
  for (const n of NAMES) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shortlist-select-'));
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const URL_VALUE = 'https://example-project.supabase.co';
const KEY_VALUE = 'test-service-role-key-not-real';

describe('getStore / storeKind', () => {
  it('uses the local store with no Supabase settings', () => {
    expect(storeKind()).toBe('local');
    const s = getStore();
    expect(s).toBeInstanceOf(LocalStore);
    expect((s as LocalStore).dir).toBe(path.join(process.cwd(), '.data', 'app'));
  });

  it('uses Supabase when the URL and the service-role key are both set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_VALUE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY_VALUE;
    expect(storeKind()).toBe('supabase');
    const s = getStore();
    expect(s).toBeInstanceOf(SupabaseStore);
    expect(getStore()).toBe(s); // one per project per process
  });

  it('stays local when only one of the two is set (or one is blank)', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_VALUE;
    expect(storeKind()).toBe('local');
    expect(getStore()).toBeInstanceOf(LocalStore);
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY_VALUE;
    expect(storeKind()).toBe('local');
    expect(getStore()).toBeInstanceOf(LocalStore);
    process.env.NEXT_PUBLIC_SUPABASE_URL = '   ';
    expect(storeKind()).toBe('local');
  });

  it('the anon key alone does not switch the store (the server needs the service-role key)', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_VALUE;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-not-real';
    expect(storeKind()).toBe('local');
  });

  it('SHORTLIST_DATA_DIR keeps tests on their own local store, even with Supabase settings', () => {
    process.env.SHORTLIST_DATA_DIR = tmp;
    expect(localDataDir()).toBe(path.resolve(tmp));
    const a = getStore();
    expect(a).toBeInstanceOf(LocalStore);
    expect((a as LocalStore).dir).toBe(path.resolve(tmp));
    expect(getStore()).toBe(a); // one store per folder

    process.env.NEXT_PUBLIC_SUPABASE_URL = URL_VALUE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = KEY_VALUE;
    expect(storeKind()).toBe('local');
    expect(getStore()).toBe(a);
  });

  it('a different SHORTLIST_DATA_DIR gets a different store', () => {
    process.env.SHORTLIST_DATA_DIR = tmp;
    const a = getStore();
    const other = path.join(tmp, 'other');
    process.env.SHORTLIST_DATA_DIR = other;
    const b = getStore();
    expect(b).not.toBe(a);
    expect((b as LocalStore).dir).toBe(path.resolve(other));
  });
});
