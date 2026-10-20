import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('favicon', () => {
  it('uses the bundled SVG icon instead of requesting /favicon.ico', () => {
    const html = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    const icon = readFileSync(
      path.join(process.cwd(), 'public/favicon.svg'),
      'utf8',
    );
    expect(html).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/u,
    );
    expect(html).not.toContain('/favicon.ico');
    expect(icon).toContain('stroke="#2563eb"');
    expect(icon).not.toContain('currentColor');
  });
});
