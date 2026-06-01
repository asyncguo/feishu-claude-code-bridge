import { describe, expect, it } from 'vitest';
import { buildBridgeSystemPrompt } from './prompt';

describe('buildBridgeSystemPrompt', () => {
  it('pins the user-facing agent identity for pi sessions', () => {
    const prompt = buildBridgeSystemPrompt({
      runtimeName: 'pi CLI',
      selfName: 'pi agent',
    });

    expect(prompt).toContain('身份表述');
    expect(prompt).toContain('身份统一按 **pi agent** 表述');
    expect(prompt).toContain('不要擅自自称 Claude、Anthropic、OpenAI、DeepSeek、Gemini');
  });

  it('mentions the supplied backend identity for other adapters too', () => {
    const prompt = buildBridgeSystemPrompt({
      runtimeName: 'Codex CLI',
      selfName: 'Codex CLI',
    });

    expect(prompt).toContain('本地 Codex CLI');
    expect(prompt).toContain('当前 agent 后端是 Codex CLI');
  });
});
