/**
 * AgentScript parser
 * ------------------
 * Línea por línea. Una acción por línea. Cero ambigüedad.
 *
 * Tokens por línea:
 *   - palabra desnuda  → bareword (e15, visible, down, Enter, https://x)
 *   - "string"         → string literal (con \" \\ \n)
 *   - 123, 1.5, 200ms  → número (ms es sufijo opcional)
 *   - ${var}           → interpolación
 *   - #                → comentario hasta fin de línea
 *
 * Las interpolaciones `${var}` también se expanden DENTRO de strings y
 * words al consumirlas con asString().
 */

export type Arg =
  | { kind: 'word'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; unit?: 'ms' }
  | { kind: 'interp'; name: string };

export interface Step {
  line: number;
  verb: string;
  args: Arg[];
  raw: string;
}

export interface ParseError {
  line: number;
  col: number;
  message: string;
  raw: string;
}

export interface ParseResult {
  steps: Step[];
  errors: ParseError[];
}

function tokenizeLine(src: string): Arg[] {
  const out: Arg[] = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') break;

    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1];
          buf += esc === 'n' ? '\n'
            : esc === 't' ? '\t'
            : esc === '"' ? '"'
            : esc === '\\' ? '\\'
            : esc;
          j += 2;
        } else {
          buf += src[j++];
        }
      }
      if (j >= n) {
        const err: any = new Error(`unterminated string literal`);
        err.col = i + 1;
        throw err;
      }
      out.push({ kind: 'string', value: buf });
      i = j + 1;
      continue;
    }

    if (c === '$' && src[i + 1] === '{') {
      const end = src.indexOf('}', i + 2);
      if (end === -1) {
        const err: any = new Error(`unterminated interpolation`);
        err.col = i + 1;
        throw err;
      }
      const name = src.slice(i + 2, end).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        const err: any = new Error(`invalid interpolation name: ${name}`);
        err.col = i + 1;
        throw err;
      }
      out.push({ kind: 'interp', name });
      i = end + 1;
      continue;
    }

    let j = i;
    while (j < n && !/[\s"#]/.test(src[j])) j++;
    const word = src.slice(i, j);
    const mNum = /^(-?\d+(?:\.\d+)?)(ms)?$/.exec(word);
    if (mNum) {
      out.push({
        kind: 'number',
        value: parseFloat(mNum[1]),
        unit: mNum[2] as 'ms' | undefined,
      });
    } else {
      out.push({ kind: 'word', value: word });
    }
    i = j;
  }

  return out;
}

export function parse(source: string): ParseResult {
  const steps: Step[] = [];
  const errors: ParseError[] = [];
  const lines = source.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    try {
      const args = tokenizeLine(raw);
      if (args.length === 0) continue;

      const first = args[0];
      if (first.kind !== 'word') {
        errors.push({
          line: idx + 1,
          col: 1,
          message: `expected verb (word) at start of line, got ${first.kind}`,
          raw,
        });
        continue;
      }
      steps.push({
        line: idx + 1,
        verb: first.value.toLowerCase(),
        args: args.slice(1),
        raw,
      });
    } catch (e: any) {
      errors.push({
        line: idx + 1,
        col: e.col ?? 1,
        message: e.message,
        raw,
      });
    }
  }

  return { steps, errors };
}

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => vars[n] ?? '');
}

export function asString(a: Arg | undefined, vars: Record<string, string>): string | undefined {
  if (!a) return undefined;
  if (a.kind === 'string') return interpolate(a.value, vars);
  if (a.kind === 'word')   return interpolate(a.value, vars);
  if (a.kind === 'number') return a.unit ? `${a.value}${a.unit}` : String(a.value);
  if (a.kind === 'interp') return vars[a.name] ?? '';
  return undefined;
}

export function asNumber(a: Arg | undefined): number | undefined {
  if (!a) return undefined;
  if (a.kind === 'number') return a.value;
  return undefined;
}

export function asWord(a: Arg | undefined): string | undefined {
  if (!a) return undefined;
  if (a.kind === 'word') return a.value;
  return undefined;
}
