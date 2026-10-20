import { describe, expect, it } from 'vitest';
import { prepareSource } from '../src/transform';

describe('prepareSource', () => {
  it('wraps a script so a bare return is legal, exactly once', () => {
    const prepared = prepareSource('return 6 * 7', false);
    expect(prepared.rewrapped).toBe(false);
    expect(prepared.isModule).toBe(false);
    expect(prepared.source.match(/\(function \(\)/g)).toHaveLength(1);
    expect(prepared.source).toContain('return 6 * 7');
  });

  it('hoists imports and wraps a module that uses a top-level return', () => {
    const code = "import _ from 'lodash';\nconst rows = [1, 2];\nreturn _.sum(rows)";
    const prepared = prepareSource(code, true);
    expect(prepared.rewrapped).toBe(true);
    expect(prepared.source.startsWith("import _ from 'lodash';")).toBe(true);
    expect(prepared.source).toContain('export default (function ()');
    expect(prepared.source).toContain('return _.sum(rows)');
    // The import must not survive inside the wrapped body.
    expect(prepared.source.match(/import _/g)).toHaveLength(1);
  });

  it('leaves a real module untouched', () => {
    const code = "import _ from 'lodash';\nexport default _.chunk([1, 2, 3], 2)";
    const prepared = prepareSource(code, true);
    expect(prepared.rewrapped).toBe(false);
    expect(prepared.source).toBe(code);
  });

  it('does not treat a return inside a function as top level', () => {
    const code = "import _ from 'lodash';\nconst f = () => { return 1 };\nexport default f()";
    const prepared = prepareSource(code, true);
    expect(prepared.rewrapped).toBe(false);
  });

  it('ignores import-like text in strings and comments', () => {
    const code = "const s = \"import x from 'y'\";\n// import z from 'w'\nreturn s";
    const prepared = prepareSource(code, false);
    expect(prepared.rewrapped).toBe(false);
    expect(prepared.source).toContain('return s');
  });

  it('keeps a side-effect import out of the wrapped body', () => {
    const code = "import 'lodash';\nreturn 1";
    const prepared = prepareSource(code, true);
    expect(prepared.rewrapped).toBe(true);
    expect(prepared.source).toBe("import 'lodash';\nexport default (function () {\n\nreturn 1\n})();");
  });
});
