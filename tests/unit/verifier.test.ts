import { describe, expect, it } from 'vitest';
import { Verifier } from '../../src/core/verifier';

describe('Verifier', () => {
  it('requires all required checks to pass and captures evidence', async () => {
    const verifier = new Verifier(
      {
        run: async (command) => ({
          exitCode: command.name === 'typecheck' ? 0 : 1,
          output: `${command.name} output`,
          durationMs: 3,
        }),
      },
      () => 10
    );
    const report = await verifier.verify([
      { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
      { name: 'tests', command: 'npm', args: ['test'] },
      { name: 'optional', command: 'npm', args: ['run', 'lint'], required: false },
    ]);
    expect(report).toMatchObject({
      status: 'failed',
      checks: [
        { name: 'typecheck', status: 'passed', exitCode: 0 },
        { name: 'tests', status: 'failed', exitCode: 1 },
        { name: 'optional', status: 'failed', required: false },
      ],
    });
  });

  it('blocks coding completion without verification', async () => {
    const verifier = new Verifier({
      run: async () => ({ exitCode: 0, output: '', durationMs: 0 }),
    });
    await expect(verifier.assertComplete([])).rejects.toMatchObject({
      code: 'VERIFICATION_REQUIRED',
    });
    await expect(
      verifier.assertComplete([{ name: 'tests', command: 'npm', args: ['test'] }])
    ).resolves.toMatchObject({ status: 'passed' });
  });
});
