import type { AgentEvent } from '../types';

interface CodexAgentMessage {
  type: 'agent_message';
  id: string;
  text: string;
}

interface CodexCommandExecution {
  type: 'command_execution';
  id: string;
  command: string;
  aggregated_output: string;
  exit_code: number | null;
  status: 'in_progress' | 'completed';
}

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
}

interface CodexRawEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  // codex exec resume may include cost info
  total_cost_usd?: number;
}

/**
 * Translate Codex CLI `--json` output lines into the bridge's standard
 * {@link AgentEvent} stream.
 *
 * Codex emits whole-item events (no per-token streaming), so text and
 * tool results arrive as complete blocks rather than deltas. The mapping:
 *
 *   thread.started  → system (sessionId = thread_id)
 *   turn.started    → (ignored)
 *   item.completed (agent_message)     → text
 *   item.started  (command_execution)  → tool_use
 *   item.completed (command_execution) → tool_result
 *   turn.completed → usage + done
 */
export function* translateEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as CodexRawEvent;

  switch (evt.type) {
    case 'thread.started': {
      if (evt.thread_id) {
        yield { type: 'system', sessionId: evt.thread_id };
      }
      return;
    }

    case 'turn.started':
      // Informational only — nothing to emit to the UI.
      return;

    case 'item.started': {
      const item = evt.item;
      if (!item) return;
      // Only command_execution items are treated as tool calls.
      // agent_message items always arrive as item.completed (no streaming).
      if (item.type === 'command_execution' && item.id && item.command) {
        yield {
          type: 'tool_use',
          id: item.id,
          name: 'bash',
          input: { command: item.command },
        };
      }
      return;
    }

    case 'item.completed': {
      const item = evt.item;
      if (!item) return;

      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        yield { type: 'text', delta: item.text };
      } else if (item.type === 'command_execution' && item.id) {
        const output = item.aggregated_output ?? '';
        const isError = item.exit_code !== 0 && item.exit_code !== null;
        yield { type: 'tool_result', id: item.id, output, isError };
      }
      return;
    }

    case 'turn.completed': {
      if (evt.usage) {
        yield {
          type: 'usage',
          inputTokens: evt.usage.input_tokens,
          outputTokens: evt.usage.output_tokens,
        };
      }
      yield { type: 'done', sessionId: evt.thread_id };
      return;
    }

    default:
      // Unknown event types are silently skipped.
      return;
  }
}
