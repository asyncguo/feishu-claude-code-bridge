import { describe, expect, it } from 'vitest';
import { AgentStore } from './agent-store';
import type { AgentAdapter, AgentRun, AgentRunOptions, AgentId } from '../agent/types';

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
  it('resolves per-scope override and falls back to default', () => {
    const claude = makeAgent('claude', 'Claude');
    const codex = makeAgent('codex', 'Codex');
    const store = new AgentStore([claude, codex], claude);

    expect(store.resolve('chat-1')).toBe(claude);

    store.set('chat-1', 'codex');
    expect(store.resolve('chat-1')).toBe(codex);
  });

  it('updates default agent and prunes unavailable overrides on adapter refresh', () => {
    const claude = makeAgent('claude', 'Claude');
    const codex = makeAgent('codex', 'Codex');
    const pi = makeAgent('pi', 'Pi');
    const store = new AgentStore([claude, codex, pi], claude);

    store.set('chat-1', 'pi');
    store.setDefaultAgent(codex);
    store.replaceAdapters([claude, codex]);

    expect(store.defaultAgent).toBe(codex);
    expect(store.getId('chat-1')).toBeUndefined();
    expect(store.resolve('chat-1')).toBe(codex);
    expect(store.listIds()).toEqual(['claude', 'codex']);
  });
});
