import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import { log } from '../core/logger';
import type { AgentId } from '../agent/types';

export interface SessionEntry {
  /** May be absent if the entry was created by /timeout before any run
   * recorded a session id. Treat absence as "no resumable session". */
  sessionId?: string;
  /** Pinned cwd for the resumable session. Absent for the same reason. */
  cwd?: string;
  /** Which agent created this session. Resume is skipped if the current
   * agent differs (Claude sessions can't be resumed by Codex and vice versa). */
  agent?: string;
  updatedAt: number;
  /** Per-scope idle-timeout override (minutes). 0 = explicitly off for this
   * scope, undefined = follow global default. /new clears the whole entry,
   * so this resets to "follow global" when the user starts a new session. */
  idleTimeoutMinutes?: number;
  /** User's explicit agent preference for this scope, set via /agent.
   * Persists across restarts and /new. undefined = follow global default. */
  preferredAgent?: AgentId;
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private data: SessionMap = {};
  private saving: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string = paths.sessionsFile) {
    this.path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await readFile(this.path, 'utf8');
      const raw = JSON.parse(text) as Record<string, Partial<SessionEntry>>;
      this.data = {};
      for (const [chatId, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.updatedAt !== 'number') continue;
        const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : undefined;
        const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined;
        const agent = typeof entry.agent === 'string' ? entry.agent : undefined;
        const idleTimeoutMinutes =
          typeof entry.idleTimeoutMinutes === 'number' ? entry.idleTimeoutMinutes : undefined;
        const preferredAgent =
          typeof entry.preferredAgent === 'string' ? (entry.preferredAgent as AgentId) : undefined;
        const hasSession = sessionId !== undefined && cwd !== undefined;
        if (!hasSession && idleTimeoutMinutes === undefined && preferredAgent === undefined)
          continue;
        this.data[chatId] = {
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          ...(agent !== undefined ? { agent } : {}),
          updatedAt: entry.updatedAt,
          ...(idleTimeoutMinutes !== undefined ? { idleTimeoutMinutes } : {}),
          ...(preferredAgent !== undefined ? { preferredAgent } : {}),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the session id for this chat if it was created in the given cwd
   * AND by the current agent. Cross-agent resume will fail (Codex can't
   * resume a Claude session), so we silently start fresh.
   * Old sessions without an `agent` field are treated as stale when the
   * current agent is known.
   */
  resumeFor(chatId: string, cwd: string, agent?: string): string | undefined {
    const entry = this.data[chatId];
    if (!entry) return undefined;
    if (entry.cwd !== cwd) return undefined;
    // If the stored session was created by a different agent (or we don't
    // know which agent created it but we know who we are), don't resume.
    if (agent && entry.agent !== agent) return undefined;
    return entry.sessionId;
  }

  getRaw(chatId: string): SessionEntry | undefined {
    return this.data[chatId];
  }

  set(chatId: string, sessionId: string, cwd: string, agent?: string): void {
    // Preserve idleTimeoutMinutes and preferredAgent across run starts —
    // they are per-scope preferences, not per-run-instance state.
    const prev = this.data[chatId];
    this.data[chatId] = {
      sessionId,
      cwd,
      ...(agent ? { agent } : {}),
      updatedAt: Date.now(),
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      ...(prev?.preferredAgent !== undefined
        ? { preferredAgent: prev.preferredAgent }
        : {}),
    };
    this.schedulePersist();
  }

  clear(chatId: string): void {
    const prev = this.data[chatId];
    if (!prev) return;
    // Preserve preferredAgent across /new — it's a user preference, not session state.
    if (prev.preferredAgent !== undefined) {
      this.data[chatId] = { preferredAgent: prev.preferredAgent, updatedAt: Date.now() };
    } else {
      delete this.data[chatId];
    }
    this.schedulePersist();
  }

  /** Per-scope idle-timeout override. `undefined` means no override set. */
  getIdleTimeoutMinutes(chatId: string): number | undefined {
    return this.data[chatId]?.idleTimeoutMinutes;
  }

  setIdleTimeoutMinutes(chatId: string, minutes: number): void {
    const clamped = Math.min(Math.max(Math.floor(minutes), 0), 120);
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev ?? { updatedAt: Date.now() }),
      idleTimeoutMinutes: clamped,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Remove the override so this scope falls back to the global default.
   * Returns true if something was actually removed. */
  clearIdleTimeoutOverride(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.idleTimeoutMinutes === undefined) return false;
    const { idleTimeoutMinutes: _, ...rest } = prev;
    this.data[chatId] = { ...rest, updatedAt: Date.now() };
    this.schedulePersist();
    return true;
  }

  /** Get the user's preferred agent for this scope (set via /agent). */
  getPreferredAgent(chatId: string): AgentId | undefined {
    return this.data[chatId]?.preferredAgent;
  }

  /** Set the user's preferred agent for this scope. Clears the existing
   * sessionId since cross-agent resume is not possible. */
  setPreferredAgent(chatId: string, agentId: AgentId): void {
    const prev = this.data[chatId];
    this.data[chatId] = {
      ...(prev?.idleTimeoutMinutes !== undefined
        ? { idleTimeoutMinutes: prev.idleTimeoutMinutes }
        : {}),
      preferredAgent: agentId,
      updatedAt: Date.now(),
    };
    this.schedulePersist();
  }

  /** Clear the preferred agent for this scope (revert to global default). */
  clearPreferredAgent(chatId: string): boolean {
    const prev = this.data[chatId];
    if (!prev || prev.preferredAgent === undefined) return false;
    const { preferredAgent: _, ...rest } = prev;
    if (Object.keys(rest).length <= 1) {
      // Only updatedAt left — remove the entry entirely
      delete this.data[chatId];
    } else {
      this.data[chatId] = { ...rest, updatedAt: Date.now() };
    }
    this.schedulePersist();
    return true;
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      })
      .catch((err: unknown) => {
        log.fail('session', err, { step: 'persist' });
      });
  }
}
