export type { AgentAdapter, AgentEvent, AgentId, AgentRun, AgentRunOptions } from './types';
export { ClaudeAdapter } from './claude/adapter';
export { CodexAdapter } from './codex/adapter';
export { PiAdapter } from './pi/adapter';

import type { AgentId } from './types';
import type { AgentAdapter } from './types';
import { ClaudeAdapter } from './claude/adapter';
import { CodexAdapter } from './codex/adapter';
import { PiAdapter } from './pi/adapter';

/** Resolve an agent id to its adapter instance. Falls back to Claude. */
export function resolveAgent(pref: AgentId | undefined): AgentAdapter {
  if (pref === 'codex') return new CodexAdapter();
  if (pref === 'pi') return new PiAdapter();
  return new ClaudeAdapter();
}
