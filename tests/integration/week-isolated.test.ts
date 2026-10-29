// Feature 6d is a mockup with made-up data (BUILD_PROGRESS.md A5): the week screen must never read the store,
// the server services, any API route or the booking export. Checked by its import graph.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const files = ['src/app/week', 'src/lib/week'].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, dir)).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(ROOT, dir, f)),
);

describe('week schedule is isolated sample data', () => {
  it('has screen and data files', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files.map((f) => [path.relative(ROOT, f), f]))('%s imports nothing from the store, server or engine', (_name, file) => {
    const src = fs.readFileSync(file, 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/storage|server|readings|\/run$|import|csv|appointments|fetch/);
    }
    expect(src).not.toMatch(/fetch\(|\/api\//);
  });
});
