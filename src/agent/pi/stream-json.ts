import type { AgentEvent } from '../types';

interface PiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiToolResult {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}

interface PiMessage {
  role: string;
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }>;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    totalTokens: number;
    cost?: { total: number };
  };
}

interface PiAssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  toolCall?: {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  content?: string;
  partial?: { role: string; content: Array<Record<string, unknown>> };
}

interface PiUpdateEvent {
  assistantMessageEvent: PiAssistantMessageEvent;
  message: PiMessage;
}

interface PiTurnEndEvent {
  message: PiMessage;
  toolResults: PiToolResult[];
}

interface PiRawEvent {
  type: string;
  id?: string;
  cwd?: string;
  // message_update
  assistantMessageEvent?: PiAssistantMessageEvent;
  message?: PiMessage;
  // turn_end
  toolResults?: PiToolResult[];
}

/**
 * Translate pi `--mode json` output into the bridge's standard
 * {@link AgentEvent} stream.
 *
 * Pi streams thinking and text as deltas within `message_update` events,
 * tool calls as `toolcall_start/delta/end`, and tool results arrive
 * bundled in the enclosing `turn_end`. The mapping:
 *
 *   session        → system (sessionId = id, cwd)
 *   agent_start    → (ignored)
 *   turn_start     → (ignored)
 *   message_start  → (ignored)
 *   message_end    → (ignored, usage extracted from final message_end/turn_end)
 *   message_update:
 *     thinking_delta  → thinking
 *     text_delta      → text
 *     toolcall_end    → tool_use (emitted once args are complete)
 *   turn_end:
 *     toolResults[]   → tool_result per entry
 *     message.usage   → usage
 *     (implicitly)    → done
 *   agent_end      → (ignored)
 */
export function* translateEvent(raw: unknown, sessionId?: string): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as PiRawEvent;

  switch (evt.type) {
    case 'session': {
      const id = evt.id;
      if (id) {
        yield {
          type: 'system',
          sessionId: id,
          cwd: evt.cwd,
        };
      }
      return;
    }

    case 'agent_start':
    case 'turn_start':
    case 'message_start':
    case 'agent_end':
      // Informational only.
      return;

    case 'message_end': {
      // Usage is embedded in the final message_end or turn_end of each turn.
      // We defer usage emission to turn_end to avoid duplicates (turn_end
      // also carries the message with the same usage object).
      const msg = evt.message;
      if (msg?.role === 'assistant' && msg.usage) {
        yield {
          type: 'usage',
          inputTokens: msg.usage.input,
          outputTokens: msg.usage.output,
          costUsd: msg.usage.cost?.total,
        };
      }
      return;
    }

    case 'message_update': {
      const aev = evt.assistantMessageEvent;
      if (!aev) return;

      switch (aev.type) {
        case 'thinking_delta':
          if (typeof aev.delta === 'string' && aev.delta) {
            yield { type: 'thinking', delta: aev.delta };
          }
          return;

        case 'text_delta':
          if (typeof aev.delta === 'string' && aev.delta) {
            yield { type: 'text', delta: aev.delta };
          }
          return;

        case 'toolcall_end': {
          const tc = aev.toolCall;
          if (tc && tc.id && tc.name) {
            yield {
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            };
          }
          return;
        }

        case 'thinking_start':
        case 'text_start':
        case 'toolcall_start':
        case 'toolcall_delta':
          // Streaming bookmarks, not emitted as standalone events.
          return;

        case 'thinking_end':
          // Full thinking content is available here but we already
          // streamed the deltas. Nothing extra to emit.
          return;

        case 'text_end':
          // Same as thinking_end — deltas already covered the content.
          return;

        default:
          return;
      }
    }

    case 'turn_end': {
      const te = evt as unknown as PiTurnEndEvent;

      // Emit tool results from this turn. In pi, tool results are bundled
      // in turn_end, not streamed individually.
      if (te.toolResults) {
        for (const tr of te.toolResults) {
          const output = tr.content
            .map((c) => c.text ?? '')
            .join('');
          yield {
            type: 'tool_result',
            id: tr.toolCallId,
            output,
            isError: tr.isError === true,
          };
        }
      }

      // Usage on the final message of the turn. We only emit if not
      // already covered by a preceding message_end (the last turn_end
      // carries the final response's usage).
      const usage = te.message?.usage;
      if (usage) {
        yield {
          type: 'usage',
          inputTokens: usage.input,
          outputTokens: usage.output,
          costUsd: usage.cost?.total,
        };
      }

      yield { type: 'done', sessionId };
      return;
    }

    default:
      return;
  }
}
