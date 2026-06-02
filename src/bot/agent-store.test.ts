import { describe, expect, it } from 'vitest';
import { AgentStore } from './agent-store';
import { SessionStore } from '../session/store';
import type { AgentAdapter, AgentRun, AgentRunOptions, AgentId } from '../agent/types';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

function makeAgent(id: AgentId, displayName?: string): AgentAdapter {
  return {
    id,
    displayName: displayName ?? id,
    async isAvailable() {
      return true;
    },
    run(_opts: AgentRunOptions): AgentRun {
      throw new Error('not implemented');
    },
  };
}

describe('AgentStore', () => {
  it('resolves per-scope override via SessionStore and falls back to default', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'agent-store-test-'));
    try {
      const sessions = new SessionStore(join(tmp, 'sessions.json'));
      const claude = makeAgent('claude', 'Claude');
      const codex = makeAgent('codex', 'Codex');
      const store = new AgentStore([claude, codex], claude);
      store.bindSessions(sessions);

      expect(store.resolve('chat-1')).toBe(claude);

      store.set('chat-1', 'codex');
      expect(store.resolve('chat-1')).toBe(codex);
      expect(store.getId('chat-1')).toBe('codex');

      store.clear('chat-1');
      expect(store.resolve('chat-1')).toBe(claude);
      expect(store.getId('chat-1')).toBeUndefined();
      await sessions.flush();
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it('updates default agent; resolve falls back when preferred adapter unavailable', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'agent-store-test-'));
    try {
      const sessions = new SessionStore(join(tmp, 'sessions.json'));
      const claude = makeAgent('claude', 'Claude');
      const codex = makeAgent('codex', 'Codex');
      const pi = makeAgent('pi', 'Pi');
      const store = new AgentStore([claude, codex, pi], claude);
      store.bindSessions(sessions);

      store.set('chat-1', 'pi');
      store.setDefaultAgent(codex);
      store.replaceAdapters([claude, codex]);

      expect(store.defaultAgent).toBe(codex);
      // pi is no longer available, so resolve falls back to default
      expect(store.resolve('chat-1')).toBe(codex);
      expect(store.listIds()).toEqual(['claude', 'codex']);
      await sessions.flush();
    } finally {
      await rm(tmp, { recursive: true });
    }
  });

  it('persists preferredAgent across SessionStore reload', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'agent-store-test-'));
    try {
      const sessionsPath = join(tmp, 'sessions.json');
      const claude = makeAgent('claude', 'Claude');
      const codex = makeAgent('codex', 'Codex');

      // First instance: set preference
      const sessions1 = new SessionStore(sessionsPath);
      const store1 = new AgentStore([claude, codex], claude);
      store1.bindSessions(sessions1);
      store1.set('chat-1', 'codex');
      await sessions1.flush();

      // Second instance: reload and verify
      const sessions2 = new SessionStore(sessionsPath);
      await sessions2.load();
      const store2 = new AgentStore([claude, codex], claude);
      store2.bindSessions(sessions2);

      expect(store2.resolve('chat-1')).toBe(codex);
      expect(store2.getId('chat-1')).toBe('codex');
    } finally {
      await rm(tmp, { recursive: true });
    }
  });
});
