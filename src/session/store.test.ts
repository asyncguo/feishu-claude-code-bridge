import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from './store';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'lark-channel-bridge-session-'));
  tempDirs.push(dir);
  return new SessionStore(join(dir, 'sessions.json'));
}

describe('SessionStore.resumeFor', () => {
  it('resumes only when cwd and agent both match', async () => {
    const store = await makeStore();
    store.set('scope-1', 'session-123', '/tmp/work', 'codex');

    expect(store.resumeFor('scope-1', '/tmp/work', 'codex')).toBe('session-123');
    expect(store.resumeFor('scope-1', '/tmp/work', 'claude')).toBeUndefined();
    expect(store.resumeFor('scope-1', '/tmp/other', 'codex')).toBeUndefined();
  });
});
