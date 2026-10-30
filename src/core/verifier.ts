import { AgentError } from './errors';
import type { JsonValue } from './types';

export interface VerificationCommand {
  name: string;
  command: string;
  args?: string[];
  required?: boolean;
  timeoutMs?: number;
}

export interface VerificationCheck {
  name: string;
  required: boolean;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  durationMs?: number;
  output?: string;
  error?: string;
}

export interface VerificationReport {
  status: 'passed' | 'failed';
  checks: VerificationCheck[];
  startedAt: number;
  completedAt: number;
}

export interface VerificationRunner {
  run(
    command: VerificationCommand,
    signal: AbortSignal
  ): Promise<{
    exitCode: number;
    output: string;
    durationMs: number;
  }>;
}

export class Verifier {
  constructor(
    private readonly runner: VerificationRunner,
    private readonly now: () => number = () => Date.now()
  ) {}

  async verify(
    commands: VerificationCommand[],
    signal: AbortSignal = new AbortController().signal
  ): Promise<VerificationReport> {
    const startedAt = this.now();
    const checks: VerificationCheck[] = [];
    for (const command of commands) {
      if (signal.aborted) {
        checks.push({
          name: command.name,
          required: command.required ?? true,
          status: 'skipped',
          error: 'cancelled',
        });
        continue;
      }
      try {
        const result = await this.runner.run(command, signal);
        checks.push({
          name: command.name,
          required: command.required ?? true,
          status: result.exitCode === 0 ? 'passed' : 'failed',
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          output: result.output.slice(0, 20_000),
        });
      } catch (error) {
        checks.push({
          name: command.name,
          required: command.required ?? true,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      status: checks.some((check) => check.required && check.status !== 'passed')
        ? 'failed'
        : 'passed',
      checks,
      startedAt,
      completedAt: this.now(),
    };
  }

  async assertComplete(
    commands: VerificationCommand[],
    signal?: AbortSignal
  ): Promise<VerificationReport> {
    if (commands.length === 0) {
      throw new AgentError(
        'VERIFICATION_REQUIRED',
        'A coding task cannot complete without verification commands'
      );
    }
    const report = await this.verify(commands, signal);
    if (report.status !== 'passed') {
      throw new AgentError(
        'VERIFICATION_FAILED',
        'One or more required verification checks failed',
        { details: report as unknown as JsonValue }
      );
    }
    return report;
  }
}
