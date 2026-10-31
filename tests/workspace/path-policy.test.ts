import { describe, expect, it } from 'vitest';
import { validatePortableWorkspacePaths } from '../../src/workspace/path-policy';

describe('portable workspace paths', () => {
  it('accepts normalized relative paths with Unicode', () => {
    expect(() =>
      validatePortableWorkspacePaths([
        'src/game.ts',
        'assets/星际飞船.glb',
        'docs/readme.md',
      ])
    ).not.toThrow();
  });

  it('rejects host-absolute, traversal and Windows-reserved paths', () => {
    for (const path of [
      '/Users/me/game.ts',
      'C:/game.ts',
      '../game.ts',
      'src/NUL',
      'src/game?.ts',
      'src/trailing.',
    ]) {
      expect(() => validatePortableWorkspacePaths([path])).toThrow(
        /portable/
      );
    }
  });

  it('rejects case-fold collisions', () => {
    expect(() =>
      validatePortableWorkspacePaths(['src/Player.js', 'src/player.js'])
    ).toThrow(/collides by case/);
  });
});
