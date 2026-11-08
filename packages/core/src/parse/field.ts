import { EngineError } from "../errors";

/** A step in a JSON path: `->'key'` / `->>'key'` / `->0`. */
export interface JsonStep {
  /** `->` keeps JSON, `->>` extracts text. */
  readonly arrow: "->" | "->>";
  readonly key: string;
  readonly isIndex: boolean;
}

/** A column reference, optionally followed by a JSON path. */
export interface FieldRef {
  readonly name: string;
  readonly json: ReadonlyArray<JsonStep>;
}

export const parseError = (message: string, details?: string): EngineError =>
  new EngineError("invalid_input", message, details ?? null);

/**
 * Scan `s` while tracking double-quote and parenthesis state, calling `visit`
 * with the index of every character that is at depth 0 and outside quotes.
 * Returning `true` from `visit` stops the scan.
 */
export const scanTopLevel = (
  s: string,
  visit: (index: number, ch: string) => boolean | void,
  /** Read a quote with no closing one, and a `{` with no `}`, as the characters they are, and keep `{…}` whole (a logic tree's values). */
  literal = false,
): void => {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"' && (!literal || closesQuote(s, i + 1))) {
      quoted = true;
      continue;
    }
    if (literal && ch === "{") {
      const close = s.indexOf("}", i + 1);
      if (close >= 0) {
        i = close;
        continue;
      }
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (depth === 0 && visit(i, ch) === true) return;
  }
};

/** Whether a quote opened before `from` is closed in `s`. */
const closesQuote = (s: string, from: number): boolean => {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return true;
  }
  return false;
};

/** Split on `sep` at depth 0, outside quotes. */
export const splitTopLevel = (s: string, sep: string, literal = false): string[] => {
  const parts: string[] = [];
  let start = 0;
  scanTopLevel(
    s,
    (i, ch) => {
      if (ch === sep) {
        parts.push(s.slice(start, i));
        start = i + 1;
      }
    },
    literal,
  );
  parts.push(s.slice(start));
  return parts;
};

export const unquote = (s: string): string => {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return t;
};

/** Parse `col`, `"odd col"`, `col->a->>b`, `col->0`. */
export const parseField = (input: string): FieldRef => {
  const s = input.trim();
  if (!s) throw parseError("Empty column name");
  // Split on -> / ->> outside quotes.
  const tokens: string[] = [];
  const arrows: Array<"->" | "->>"> = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === "-" && s[i + 1] === ">") {
      const long = s[i + 2] === ">";
      tokens.push(s.slice(start, i));
      arrows.push(long ? "->>" : "->");
      i += long ? 2 : 1;
      start = i + 1;
    }
  }
  tokens.push(s.slice(start));

  const name = unquote(tokens[0]!);
  if (!name) throw parseError("Empty column name", `in "${input}"`);
  const json: JsonStep[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const raw = tokens[i]!.trim();
    if (!raw) throw parseError("Invalid JSON path", `in "${input}"`);
    const isIndex = /^-?\d+$/.test(raw);
    json.push({ arrow: arrows[i - 1]!, key: isIndex ? raw : unquote(raw), isIndex });
  }
  return { name, json };
};
