import type { AgentId, AgentAdapter } from '../agent/types';
import { log } from '../core/logger';

/**
 * Per-scope agent preference store. Lets each chat / topic choose which
 * agent backend to use, overriding the global default set at startup or
 * via `config.preferences.agent`.
 *
 * Not persisted to disk — resets on restart. Lightweight enough to keep
 * all three adapter instances alive for the process lifetime.
 */
export class AgentStore {
  /** scope → AgentId mapping. Undefined entries use the default agent. */
  private scopeAgent = new Map<string, AgentId>();

  /** All available adapters, keyed by AgentId. */
  private adapters = new Map<AgentId, AgentAdapter>();

  /** The global default adapter (from startup config / CLI flag). */
  defaultAgent: AgentAdapter;

  constructor(adapters: AgentAdapter[], defaultAgent: AgentAdapter) {
    this.defaultAgent = defaultAgent;
    this.replaceAdapters(adapters);
  }

  /** Resolve the effective agent for a scope. Falls back to defaultAgent. */
  resolve(scope: string): AgentAdapter {
    const id = this.scopeAgent.get(scope);
    if (id) {
      const adapter = this.adapters.get(id);
      if (adapter) return adapter;
    }
    return this.defaultAgent;
  }

  /** Get the raw AgentId for a scope (or undefined if using default). */
  getId(scope: string): AgentId | undefined {
    return this.scopeAgent.get(scope);
  }

  /** Set agent preference for a scope. */
  set(scope: string, agentId: AgentId): void {
    const prev = this.scopeAgent.get(scope);
    this.scopeAgent.set(scope, agentId);
    log.info('agent-store', 'set', { scope, agentId, previous: prev });
  }

  /** Clear per-scope preference (revert to default). */
  clear(scope: string): boolean {
    const had = this.scopeAgent.delete(scope);
    if (had) log.info('agent-store', 'clear', { scope });
    return had;
  }

  /** Replace the available adapter set, pruning dead per-scope preferences. */
  replaceAdapters(adapters: AgentAdapter[]): void {
    this.adapters = new Map(adapters.map((a) => [a.id as AgentId, a]));
    for (const [scope, agentId] of this.scopeAgent.entries()) {
      if (!this.adapters.has(agentId)) {
        this.scopeAgent.delete(scope);
        log.info('agent-store', 'prune', { scope, agentId });
      }
    }
  }

  /** Update the global default agent used when a scope has no override. */
  setDefaultAgent(agent: AgentAdapter): void {
    this.defaultAgent = agent;
    log.info('agent-store', 'default-set', { agentId: agent.id });
  }

  /** Get all registered agent ids. */
  listIds(): AgentId[] {
    return [...this.adapters.keys()];
  }

  /** Get an adapter by id. Returns undefined if not registered. */
  getById(id: AgentId): AgentAdapter | undefined {
    return this.adapters.get(id);
  }
}
