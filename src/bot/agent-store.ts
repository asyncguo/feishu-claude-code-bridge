import type { AgentId, AgentAdapter } from '../agent/types';
import type { SessionStore } from '../session/store';
import { log } from '../core/logger';

/**
 * Per-scope agent preference store. Lets each chat / topic choose which
 * agent backend to use, overriding the global default set at startup or
 * via `config.preferences.agent`.
 *
 * Per-scope preferences are persisted in sessions.json (via SessionStore)
 * and survive restarts.
 */
export class AgentStore {
  /** All available adapters, keyed by AgentId. */
  private adapters = new Map<AgentId, AgentAdapter>();

  /** The global default adapter (from startup config / CLI flag). */
  defaultAgent: AgentAdapter;

  /** Session store for reading persisted per-scope agent preferences. */
  private sessions: SessionStore | undefined;

  constructor(adapters: AgentAdapter[], defaultAgent: AgentAdapter) {
    this.defaultAgent = defaultAgent;
    this.replaceAdapters(adapters);
  }

  /** Bind the session store so resolve() can read persisted preferences. */
  bindSessions(sessions: SessionStore): void {
    this.sessions = sessions;
  }

  /** Resolve the effective agent for a scope. Checks persisted preference
   * in sessions.json, then falls back to defaultAgent. */
  resolve(scope: string): AgentAdapter {
    const preferredId = this.sessions?.getPreferredAgent(scope);
    if (preferredId) {
      const adapter = this.adapters.get(preferredId);
      if (adapter) return adapter;
    }
    return this.defaultAgent;
  }

  /** Get the persisted preferred AgentId for a scope (or undefined if using default). */
  getId(scope: string): AgentId | undefined {
    return this.sessions?.getPreferredAgent(scope);
  }

  /** Set agent preference for a scope (persisted via SessionStore). */
  set(scope: string, agentId: AgentId): void {
    if (!this.sessions) return;
    this.sessions.setPreferredAgent(scope, agentId);
    log.info('agent-store', 'set', { scope, agentId });
  }

  /** Clear per-scope preference (revert to default). */
  clear(scope: string): boolean {
    if (!this.sessions) return false;
    const cleared = this.sessions.clearPreferredAgent(scope);
    if (cleared) log.info('agent-store', 'clear', { scope });
    return cleared;
  }

  /** Replace the available adapter set. */
  replaceAdapters(adapters: AgentAdapter[]): void {
    this.adapters = new Map(adapters.map((a) => [a.id as AgentId, a]));
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
