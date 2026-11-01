import { describe, expect, it } from 'vitest';
import { TextCodeIntelligence } from '../../src/intelligence/text-index';
import { MemoryFileSystem } from '../../src/virtual';

describe('REQ-LSP-001 portable text code intelligence', () => {
  it('finds symbols, definitions and references without a language server', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write(
      'src/value.ts',
      new TextEncoder().encode(
        'export function computeValue(input: number) { return input + 1; }\n'
      )
    );
    await vfs.write(
      'src/use.ts',
      new TextEncoder().encode(
        'import { computeValue } from "./value";\nconsole.log(computeValue(1));\n'
      )
    );
    const intelligence = new TextCodeIntelligence(vfs);
    expect(await intelligence.capabilities()).toMatchObject({
      provider: 'text',
      symbols: true,
      diagnostics: false,
      codeActions: false,
    });
    expect(await intelligence.symbols('compute')).toMatchObject([
      {
        name: 'computeValue',
        kind: 'function',
        path: 'src/value.ts',
        range: { startLine: 1 },
      },
    ]);
    expect(await intelligence.definition('computeValue')).toEqual([
      expect.objectContaining({ path: 'src/value.ts' }),
    ]);
    expect(await intelligence.references('computeValue')).toHaveLength(3);
    expect(await intelligence.diagnostics(['src/value.ts'])).toEqual([]);
    expect(
      await intelligence.codeActions('src/value.ts', {
        startLine: 1,
        startColumn: 1,
        endLine: 1,
        endColumn: 5,
      })
    ).toEqual([]);
  });

  it('ignores binary and oversized files and honours cancellation', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('assets/data.ts', new Uint8Array([0, 1, 2, 3]));
    await vfs.write(
      'src/huge.ts',
      new TextEncoder().encode('x'.repeat(600 * 1024))
    );
    const intelligence = new TextCodeIntelligence(vfs);
    expect(await intelligence.symbols('x')).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      intelligence.symbols('', controller.signal)
    ).rejects.toMatchObject({
      code: 'VFS_ABORTED',
    });
  });
});
