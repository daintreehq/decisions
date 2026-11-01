/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) for the JSON subset Decisions signs.
 *
 * Supported values: null, booleans, strings, finite numbers (safe integers recommended),
 * dense arrays and plain objects. `undefined` object members are omitted (as JSON.stringify does).
 * Object members are sorted by UTF-16 code units, per RFC 8785 section 3.2.3. Number serialisation
 * uses ECMAScript `Number#toString`, which RFC 8785 mandates.
 *
 * This is deliberately strict because signatures depend on byte-identical output everywhere:
 * lone surrogates, accessors, `toJSON` hooks, sparse arrays and non-plain objects (Date, Map, class
 * instances) are rejected rather than silently normalised.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };

export function canonicalize(value: unknown): string {
  return ser(value, 0);
}

const MAX_DEPTH = 64;

function checkString(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) throw new TypeError('canonicalize: lone surrogate');
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('canonicalize: lone surrogate');
    }
  }
  return JSON.stringify(s);
}

function ser(v: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('canonicalize: nesting too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return checkString(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalize: non-finite number');
      return Object.is(v, -0) ? '0' : String(v);
    case 'object': {
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (let i = 0; i < v.length; i++) {
          if (!Object.prototype.hasOwnProperty.call(v, i))
            throw new TypeError('canonicalize: sparse array');
          const d = Object.getOwnPropertyDescriptor(v, i)!;
          if (!('value' in d)) throw new TypeError('canonicalize: accessor in array');
          parts.push(d.value === undefined ? 'null' : ser(d.value, depth + 1));
        }
        return '[' + parts.join(',') + ']';
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('canonicalize: non-plain object');
      }
      const keys = Object.keys(v as object).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(v, k)!;
        if (!('value' in d)) throw new TypeError('canonicalize: accessor property');
        if (d.value === undefined) continue;
        if (k === 'toJSON' && typeof d.value === 'function')
          throw new TypeError('canonicalize: toJSON hook');
        parts.push(checkString(k) + ':' + ser(d.value, depth + 1));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`canonicalize: unsupported type ${typeof v}`);
  }
}
