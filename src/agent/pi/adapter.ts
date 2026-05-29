import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import { buildBridgeSystemPrompt } from '../shared/prompt';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateEvent } from './stream-json';

export interface PiAdapterOptions {
  binary?: string;
}

type PiChild = ChildProcessByStdio<null, Readable, Readable>;

const BRIDGE_SYSTEM_PROMPT = buildBridgeSystemPrompt('pi CLI');

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi Coding Agent';

  private readonly binary: string;

  constructor(opts: PiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'pi';
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    // pi supports --append-system-prompt, so we inject the bridge
    // instructions separately rather than prepending to the user prompt.
    const args = [
      '--mode', 'json',
      '--no-context-files',
      '--append-system-prompt', BRIDGE_SYSTEM_PROMPT,
    ];

    // pi uses --session-id for exact session resume (UUID from the
    // `session` event). Unlike Claude's --resume, pi recreates the
    // session in-place rather than picking up an existing file.
    if (opts.sessionId) {
      args.push('--session-id', opts.sessionId);
    }

    if (opts.model) args.push('--model', opts.model);

    // The prompt is the final positional argument.
    args.push(opts.prompt);

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.info('agent', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      hasSession: Boolean(opts.sessionId),
      promptChars: opts.prompt.length,
      model: opts.model,
      adapter: 'pi',
    });

    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) log.warn('agent', 'stderr', { line, adapter: 'pi' });
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('agent', 'exit', {
        pid: child.pid ?? null,
        code,
        signal,
        adapter: 'pi',
      });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('agent', 'stop-sigterm', {
          pid: child.pid ?? null,
          graceMs: stopGraceMs,
          adapter: 'pi',
        });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('agent', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
                adapter: 'pi',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: PiChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err
        ? `failed to spawn pi: ${err.message}`
        : 'spawn returned no pid',
    };
    return;
  }

  // pi emits session.id on the first line — capture it so we can pass it
  // through to the done event (turn_end doesn't carry the session id).
  let sessionId: string | undefined;

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      // Update sessionId when we see the session event
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as Record<string, unknown>).type === 'session' &&
        typeof (parsed as Record<string, unknown>).id === 'string'
      ) {
        sessionId = (parsed as Record<string, unknown>).id as string;
      }
      yield* translateEvent(parsed, sessionId);
    }
  } finally {
    rl.close();
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield {
      type: 'error',
      message: `pi exited with code ${exitCode}${detail}`,
    };
  } else if (runtimeError) {
    yield {
      type: 'error',
      message: `pi runtime error: ${runtimeError.message}`,
    };
  }
}
