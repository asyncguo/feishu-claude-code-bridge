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

describe('SessionStore.preferredAgent', () => {
  it('set/get/clear preferred agent', async () => {
    const store = await makeStore();

    expect(store.getPreferredAgent('chat-1')).toBeUndefined();

    store.setPreferredAgent('chat-1', 'codex');
    expect(store.getPreferredAgent('chat-1')).toBe('codex');

    store.clearPreferredAgent('chat-1');
    await store.flush();
    expect(store.getPreferredAgent('chat-1')).toBeUndefined();
  });

  it('clear() preserves preferredAgent', async () => {
    const store = await makeStore();
    store.set('chat-1', 'session-1', '/tmp', 'codex');
    store.setPreferredAgent('chat-1', 'codex');

    store.clear('chat-1');
    await store.flush();
    expect(store.getPreferredAgent('chat-1')).toBe('codex');
    expect(store.resumeFor('chat-1', '/tmp', 'codex')).toBeUndefined();
  });

  it('setPreferredAgent clears old sessionId', async () => {
    const store = await makeStore();
    store.set('chat-1', 'session-1', '/tmp', 'claude');

    store.setPreferredAgent('chat-1', 'codex');
    await store.flush();
    expect(store.resumeFor('chat-1', '/tmp', 'claude')).toBeUndefined();
    expect(store.resumeFor('chat-1', '/tmp', 'codex')).toBeUndefined();
    expect(store.getPreferredAgent('chat-1')).toBe('codex');
  });

  it('persists and reloads preferredAgent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lark-channel-bridge-session-'));
    tempDirs.push(dir);
    const path = join(dir, 'sessions.json');

    const store1 = new SessionStore(path);
    store1.setPreferredAgent('chat-1', 'pi');
    await store1.flush();

    const store2 = new SessionStore(path);
    await store2.load();
    expect(store2.getPreferredAgent('chat-1')).toBe('pi');
  });
});
