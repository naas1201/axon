// Final stage of the scanner: decide how submitted code is evaluated, and
// rewrite the one shape agents actually write but ESM forbids, a module with a
// top-level `return`.
//
//   import _ from 'lodash'
//   const rows = [1, 2, 3]
//   return _.sum(rows)          // SyntaxError: return not in a function
//
// The imports are hoisted to the top, the rest is wrapped in an IIFE and
// exported as the default. A real module (`export default ...`, `export const`)
// is left alone, because wrapping it would make its exports illegal.

import { isIdentPart, isIdentStart, readString, skipString } from './lexer';

interface ImportRange {
  start: number;
  end: number;
}

function skipLayout(src: string, start: number): number {
  let p = start;
  for (;;) {
    while (p < src.length && /\s/.test(src[p])) p++;
    if (src[p] === '/' && src[p + 1] === '/') {
      const nl = src.indexOf('\n', p);
      p = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (src[p] === '/' && src[p + 1] === '*') {
      const end = src.indexOf('*/', p + 2);
      p = end === -1 ? src.length : end + 2;
      continue;
    }
    return p;
  }
}

/** Ranges of top-level static import statements, in source order. */
function importRanges(src: string): ImportRange[] {
  const ranges: ImportRange[] = [];
  let i = 0;
  let depth = 0;
  let prev = '';

  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      prev = '"';
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      prev = c;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      prev = c;
      i++;
      continue;
    }
    if (isIdentStart(c) && !(i > 0 && isIdentPart(src[i - 1]))) {
      let end = i + 1;
      while (end < src.length && isIdentPart(src[end])) end++;
      const word = src.slice(i, end);
      if (word === 'import' && depth === 0 && prev !== '.') {
        const after = skipLayout(src, end);
        const next = src[after];
        // `import(...)` and `import.meta` are expressions, not statements.
        if (next !== '(' && next !== '.') {
          let q = after;
          let literal: { value: string; end: number } | null = null;
          while (q < src.length) {
            const ch = src[q];
            if (ch === '/' && src[q + 1] === '/') {
              const nl = src.indexOf('\n', q);
              q = nl === -1 ? src.length : nl + 1;
              continue;
            }
            if (ch === '/' && src[q + 1] === '*') {
              const close = src.indexOf('*/', q + 2);
              q = close === -1 ? src.length : close + 2;
              continue;
            }
            const lit = readString(src, q);
            if (lit) {
              literal = lit;
              break;
            }
            if (ch === ';') break;
            q++;
          }
          if (literal) {
            let stop = skipLayout(src, literal.end);
            if (src[stop] === ';') stop++;
            ranges.push({ start: i, end: stop });
          }
        }
      }
      prev = 'a';
      i = end;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return ranges;
}

/** True when the word appears outside strings, comments and nested blocks. */
function hasTopLevelKeyword(src: string, keyword: string): boolean {
  let i = 0;
  let depth = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(src, i);
      prev = '"';
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      prev = c;
      i++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth = Math.max(0, depth - 1);
      prev = c;
      i++;
      continue;
    }
    if (isIdentStart(c) && !(i > 0 && isIdentPart(src[i - 1]))) {
      let end = i + 1;
      while (end < src.length && isIdentPart(src[end])) end++;
      if (depth === 0 && prev !== '.' && src.slice(i, end) === keyword) return true;
      prev = 'a';
      i = end;
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return false;
}

export interface PreparedSource {
  source: string;
  isModule: boolean;
  /** True when the code was rewritten from `import ...; return ...` form. */
  rewrapped: boolean;
}

/**
 * Turn user code into something QuickJS can evaluate, without changing what a
 * well-formed module means. Scripts keep the IIFE wrapper that makes a bare
 * `return` legal; modules with a top-level return get their imports hoisted
 * and their body wrapped.
 */
export function prepareSource(code: string, isModule: boolean): PreparedSource {
  if (!isModule) {
    return {
      source: `(function () {\n${code}\n})()`,
      isModule: false,
      rewrapped: false,
    };
  }

  const ranges = importRanges(code);
  const body = ranges.length
    ? ranges
        .slice()
        .reverse()
        .reduce((acc, range) => acc.slice(0, range.start) + acc.slice(range.end), code)
    : code;

  const exportsSomething = hasTopLevelKeyword(body, 'export');
  const returnsValue = hasTopLevelKeyword(body, 'return');

  if (!returnsValue || exportsSomething) {
    return { source: code, isModule: true, rewrapped: false };
  }

  const imports = ranges.map((range) => code.slice(range.start, range.end).trim()).join('\n');
  const wrapped = `${imports ? `${imports}\n` : ''}export default (function () {\n${body}\n})();`;
  return { source: wrapped, isModule: true, rewrapped: true };
}
