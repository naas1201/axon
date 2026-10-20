// A tiny, dependency-free scanner that finds static and dynamic import
// specifiers in submitted code. It is deliberately not a full parser: it only
// needs to answer "which packages must I resolve before I start the sandbox".
// It skips comments and string literals so that `const s = "import x from 'y'"`
// does not trigger a fetch.

export interface ImportScan {
  /** Unique specifiers, in source order, capped at 8. */
  specifiers: string[];
  /** True when the code uses import/export and must run as a module. */
  isModule: boolean;
}

const MAX_SCAN = 600;
const MAX_SPECIFIERS = 8;

export function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

export function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

export function skipString(src: string, start: number): number {
  const quote = src[start];
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return src.length;
}

function skipTrivia(src: string, start: number): number {
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

export function readString(src: string, start: number): { value: string; end: number } | null {
  const quote = src[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      out += src[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (c === quote) return { value: out, end: i + 1 };
    out += c;
    i++;
  }
  return null;
}

interface Clause {
  spec: string | null;
  /** False when the keyword turned out to be a property name, not a statement. */
  matched: boolean;
}

// Scans the clause that follows an `import` or `export` keyword.
function scanClause(src: string, pos: number, isExport: boolean): Clause {
  let p = skipTrivia(src, pos);

  // import("x") and dynamic import()
  if (src[p] === '(') {
    p = skipTrivia(src, p + 1);
    const lit = readString(src, p);
    return { spec: lit ? lit.value : null, matched: true };
  }

  // import "x" (side effect only)
  const direct = readString(src, p);
  if (direct) return { spec: direct.value, matched: true };

  // import.meta
  if (src[p] === '.') return { spec: null, matched: true };

  // `{ import: 1 }` or `{ export: 1 }`: a property name, not a statement.
  if (src[p] === ':' || src[p] === ',' || src[p] === ')' || src[p] === '}' || src[p] === '=') {
    return { spec: null, matched: false };
  }

  // export const/function/class/default ... is a module, but has no specifier.
  if (isExport && src[p] !== '{' && src[p] !== '*') return { spec: null, matched: true };

  const limit = Math.min(src.length, p + MAX_SCAN);
  let i = p;
  while (i < limit) {
    const c = src[i];
    if (c === ';') return { spec: null, matched: false };
    const lit = readString(src, i);
    if (lit) {
      // A string before `from` is not a module specifier; skip it and keep
      // looking for `from`.
      i = lit.end;
      continue;
    }
    if (isIdentPart(c) && !(i > 0 && isIdentPart(src[i - 1]))) {
      let end = i + 1;
      while (end < src.length && isIdentPart(src[end])) end++;
      if (src.slice(i, end) === 'from') {
        const q = skipTrivia(src, end);
        const s = readString(src, q);
        return { spec: s ? s.value : null, matched: true };
      }
      i = end;
      continue;
    }
    i++;
  }
  return { spec: null, matched: false };
}

export function collectImports(source: string): ImportScan {
  const specifiers: string[] = [];
  const seen = new Set<string>();
  let isModule = false;
  let i = 0;
  let prev = '';

  while (i < source.length) {
    const c = source[i];

    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i);
      prev = '"';
      continue;
    }

    if (isIdentStart(c)) {
      let end = i + 1;
      while (end < source.length && isIdentPart(source[end])) end++;
      const word = source.slice(i, end);
      if ((word === 'import' || word === 'export') && prev !== '.') {
        const clause = scanClause(source, end, word === 'export');
        if (clause.matched) isModule = true;
        if (clause.spec && !seen.has(clause.spec)) {
          seen.add(clause.spec);
          if (specifiers.length < MAX_SPECIFIERS) specifiers.push(clause.spec);
        }
      }
      prev = 'a';
      i = end;
      continue;
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return { specifiers, isModule };
}
