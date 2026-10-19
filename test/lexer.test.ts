import { describe, expect, it } from 'vitest';

import { collectImports } from '../src/lexer';

describe('collectImports', () => {
  it('finds default, named, namespace and side-effect imports', () => {
    const source = `
      import _ from 'lodash'
      import { z } from "zod"
      import * as R from 'ramda'
      import 'polyfill'
      import(
        'lazy'
      )
      export { thing } from './thing.js'
      export * from 'other'
    `;
    expect(collectImports(source).specifiers).toEqual([
      'lodash',
      'zod',
      'ramda',
      'polyfill',
      'lazy',
      './thing.js',
      'other',
    ]);
    expect(collectImports(source).isModule).toBe(true);
  });

  it('ignores import words inside strings, templates and comments', () => {
    const source = `
      // import fake from 'not-a-module'
      /* import other from 'also-not' */
      const a = "import x from 'string-literal'"
      const b = 'export * from "nope"'
      const c = \`import("template")\`
      return a + b + c
    `;
    expect(collectImports(source).specifiers).toEqual([]);
    expect(collectImports(source).isModule).toBe(false);
  });

  it('does not treat property access as an import', () => {
    const source = `const loader = { import: 1 }; return loader.import`;
    expect(collectImports(source).specifiers).toEqual([]);
    expect(collectImports(source).isModule).toBe(false);
  });

  it('dedupes and caps the list at 8 specifiers', () => {
    const source = Array.from({ length: 12 }, (_, i) => `import m${i} from 'pkg${i}'`).join('\n');
    const scan = collectImports(`${source}\nimport again from 'pkg0'`);
    expect(scan.specifiers).toHaveLength(8);
    expect(new Set(scan.specifiers).size).toBe(8);
    expect(scan.specifiers[0]).toBe('pkg0');
  });

  it('is not confused by a from inside a later statement', () => {
    const source = `
      import a from 'first'
      const x = 1
      function f() { return 'from "ghost"' }
    `;
    expect(collectImports(source).specifiers).toEqual(['first']);
  });

  it('accepts a module with only an export default', () => {
    const scan = collectImports('export default 40 + 2');
    expect(scan.isModule).toBe(true);
    expect(scan.specifiers).toEqual([]);
  });
});
