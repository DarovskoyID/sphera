/**
 * Spreadsheet formulas, evaluated as you type.
 *
 * The same grammar lives in the backend (`formulas.py`), which exports and
 * printed views use, so a downloaded CSV shows what the author saw. Keep the
 * two in step: numbers, strings, refs, ranges, `+ - * / ^ % &`, comparisons and
 * the functions in FUNCS.
 */
import type { Cell } from './types';

export const ERROR = '#ERROR!';
export const CYCLE = '#CYCLE!';
export const DIV0 = '#DIV/0!';
const ERRORS = new Set<string>([ERROR, CYCLE, DIV0]);
const MAX_DEPTH = 24;
const MAX_RANGE = 20_000;

export type Value = number | string | boolean | Value[];

class CalcError extends Error {
  readonly text: string;

  constructor(text = ERROR) {
    super(text);
    this.text = text;
  }
}

export function colName(index: number): string {
  let out = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export const ref = (col: number, row: number) => `${colName(col)}${row}`;

export function parseRef(text: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4})$/.exec(text.toUpperCase());
  return m ? { col: colIndex(m[1]), row: Number(m[2]) } : null;
}

function num(value: Value | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined || value === '') return 0;
  if (Array.isArray(value)) return num(value[0]);
  if (ERRORS.has(value)) throw new CalcError(value);
  const parsed = Number(value.trim().replace(/\s/g, '').replace(',', '.'));
  if (Number.isNaN(parsed)) throw new CalcError();
  return parsed;
}

function text(value: Value | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'number') return formatNumber(value);
  return value;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ERROR;
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e10) / 1e10);
}

const flat = (args: Value[]): Value[] => args.flatMap(a => (Array.isArray(a) ? flat(a) : [a]));

function numbers(args: Value[]): number[] {
  const out: number[] = [];
  for (const a of flat(args)) {
    if (a === '' || a === undefined) continue;
    if (typeof a === 'number') { out.push(a); continue; }
    try { out.push(num(a)); } catch { /* text cells are skipped, as in a spreadsheet */ }
  }
  return out;
}

function truthy(value: Value | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return !['', 'FALSE', '0', 'НЕТ'].includes(value.trim().toUpperCase());
  if (Array.isArray(value)) return value.some(truthy);
  return num(value) !== 0;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const FUNCS: Record<string, (args: Value[]) => Value> = {
  SUM: a => sum(numbers(a)),
  AVERAGE: a => (numbers(a).length ? sum(numbers(a)) / numbers(a).length : 0),
  AVG: a => (numbers(a).length ? sum(numbers(a)) / numbers(a).length : 0),
  MIN: a => (numbers(a).length ? Math.min(...numbers(a)) : 0),
  MAX: a => (numbers(a).length ? Math.max(...numbers(a)) : 0),
  COUNT: a => numbers(a).length,
  COUNTA: a => flat(a).filter(x => x !== '' && x !== undefined).length,
  ROUND: a => {
    const digits = a.length > 1 ? Math.trunc(num(a[1])) : 0;
    const factor = 10 ** digits;
    return Math.round(num(a[0]) * factor) / factor;
  },
  ABS: a => Math.abs(num(a[0])),
  INT: a => Math.trunc(num(a[0])),
  SQRT: a => num(a[0]) ** 0.5,
  POWER: a => num(a[0]) ** num(a[1]),
  PRODUCT: a => numbers(a).reduce((x, y) => x * y, 1),
  IF: a => (truthy(a[0]) ? a[1] : (a.length > 2 ? a[2] : '')),
  AND: a => flat(a).every(truthy),
  OR: a => flat(a).some(truthy),
  NOT: a => !truthy(a[0]),
  CONCAT: a => flat(a).map(text).join(''),
  CONCATENATE: a => flat(a).map(text).join(''),
  LEN: a => text(a[0]).length,
  UPPER: a => text(a[0]).toUpperCase(),
  LOWER: a => text(a[0]).toLowerCase(),
  TRIM: a => text(a[0]).trim(),
  LEFT: a => text(a[0]).slice(0, a.length > 1 ? Math.trunc(num(a[1])) : 1),
  RIGHT: a => text(a[0]).slice(-(a.length > 1 ? Math.trunc(num(a[1])) : 1)),
  TODAY: () => new Date().toISOString().slice(0, 10),
  PERCENT: a => num(a[0]) / 100,
};

export const FUNC_NAMES = Object.keys(FUNCS).sort();

type Lookup = (start: string, end: string | null) => Value;

class Parser {
  private i = 0;
  private readonly s: string;
  private readonly lookup: Lookup;

  constructor(s: string, lookup: Lookup) {
    this.s = s;
    this.lookup = lookup;
  }

  parse(): Value {
    const value = this.comparison();
    this.ws();
    if (this.i < this.s.length) throw new CalcError();
    return value;
  }

  private ws() { while (this.i < this.s.length && ' \t'.includes(this.s[this.i])) this.i++; }

  private peek() { this.ws(); return this.s[this.i] ?? ''; }

  private eat(token: string) {
    this.ws();
    if (this.s.startsWith(token, this.i)) { this.i += token.length; return true; }
    return false;
  }

  private comparison(): Value {
    const left = this.additive();
    for (const token of ['<>', '<=', '>=', '=', '<', '>']) {
      if (this.eat(token)) {
        const right = this.additive();
        if (token === '=' || token === '<>') {
          const same = typeof left === 'string' || typeof right === 'string' ? text(left) === text(right) : num(left) === num(right);
          return token === '=' ? same : !same;
        }
        const a = num(left);
        const b = num(right);
        return token === '<' ? a < b : token === '>' ? a > b : token === '<=' ? a <= b : a >= b;
      }
    }
    return left;
  }

  private additive(): Value {
    let value = this.multiplicative();
    for (;;) {
      if (this.eat('+')) value = num(value) + num(this.multiplicative());
      else if (this.eat('-')) value = num(value) - num(this.multiplicative());
      else if (this.eat('&')) value = text(value) + text(this.multiplicative());
      else return value;
    }
  }

  private multiplicative(): Value {
    let value = this.power();
    for (;;) {
      if (this.eat('*')) value = num(value) * num(this.power());
      else if (this.eat('/')) {
        const divisor = num(this.power());
        if (divisor === 0) throw new CalcError(DIV0);
        value = num(value) / divisor;
      } else return value;
    }
  }

  private power(): Value {
    const value = this.unary();
    if (this.eat('^')) return num(value) ** num(this.power());
    return value;
  }

  private unary(): Value {
    if (this.eat('-')) return -num(this.unary());
    if (this.eat('+')) return num(this.unary());
    return this.postfix();
  }

  private postfix(): Value {
    const value = this.atom();
    if (this.eat('%')) return num(value) / 100;
    return value;
  }

  private atom(): Value {
    this.ws();
    if (this.eat('(')) {
      const value = this.comparison();
      if (!this.eat(')')) throw new CalcError();
      return value;
    }
    const ch = this.peek();
    if (ch === '"') {
      this.i++;
      let out = '';
      while (this.i < this.s.length) {
        const c = this.s[this.i++];
        if (c === '"') {
          if (this.s[this.i] === '"') { out += '"'; this.i++; continue; }
          return out;
        }
        out += c;
      }
      throw new CalcError();
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^\d*(\.\d+)?/.exec(this.s.slice(this.i));
      if (!m || !m[0]) throw new CalcError();
      this.i += m[0].length;
      return Number(m[0]);
    }
    const name = /^[A-Za-z][A-Za-z0-9_.]*/.exec(this.s.slice(this.i));
    if (!name) throw new CalcError();
    const word = name[0].toUpperCase();
    const after = this.i + name[0].length;
    const rest = this.s.slice(after);
    if (rest.trimStart().startsWith('(')) {
      this.i = after + (rest.length - rest.trimStart().length) + 1;
      const args: Value[] = [];
      if (!this.eat(')')) {
        for (;;) {
          args.push(this.comparison());
          if (this.eat(',') || this.eat(';')) continue;
          if (this.eat(')')) break;
          throw new CalcError();
        }
      }
      const func = FUNCS[word];
      if (!func) throw new CalcError();
      try {
        return func(args);
      } catch (e) {
        throw e instanceof CalcError ? e : new CalcError();
      }
    }
    const refMatch = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4})/.exec(this.s.slice(this.i).toUpperCase());
    if (refMatch) {
      this.i += refMatch[0].length;
      const start = `${refMatch[1]}${refMatch[2]}`;
      if (this.eat(':')) {
        const endMatch = /^\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4})/.exec(this.s.slice(this.i).toUpperCase());
        if (!endMatch) throw new CalcError();
        this.i += endMatch[0].length;
        return this.lookup(start, `${endMatch[1]}${endMatch[2]}`);
      }
      return this.lookup(start, null);
    }
    if (word === 'TRUE' || word === 'FALSE') { this.i = after; return word === 'TRUE'; }
    throw new CalcError();
  }
}

function literal(raw: string): Value {
  if (!raw) return '';
  const trimmed = raw.trim();
  const parsed = Number(trimmed.replace(/\s/g, '').replace(',', '.'));
  return trimmed !== '' && !Number.isNaN(parsed) ? parsed : raw;
}

/** Value of one cell: the literal, or the result of its formula. */
export function evaluate(cells: Record<string, Cell>, at: string, stack: string[] = [], cache: Map<string, Value> = new Map()): Value {
  const cached = cache.get(at);
  if (cached !== undefined) return cached;
  if (stack.includes(at) || stack.length > MAX_DEPTH) return CYCLE;
  const raw = cells[at]?.v ?? '';
  if (!raw.startsWith('=')) {
    const value = literal(raw);
    cache.set(at, value);
    return value;
  }
  const lookup: Lookup = (start, end) => {
    if (end === null) return evaluate(cells, start, [...stack, at], cache);
    const a = parseRef(start);
    const b = parseRef(end);
    if (!a || !b) throw new CalcError();
    const [x1, x2] = [Math.min(a.col, b.col), Math.max(a.col, b.col)];
    const [y1, y2] = [Math.min(a.row, b.row), Math.max(a.row, b.row)];
    if ((x2 - x1 + 1) * (y2 - y1 + 1) > MAX_RANGE) throw new CalcError();
    const out: Value[] = [];
    for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) out.push(evaluate(cells, ref(x, y), [...stack, at], cache));
    return out;
  };
  let value: Value;
  try {
    value = new Parser(raw.slice(1), lookup).parse();
  } catch (e) {
    value = e instanceof CalcError ? e.text : ERROR;
  }
  if (Array.isArray(value)) value = value.length ? value[0] : '';
  cache.set(at, value);
  return value;
}

/** What a cell shows, as text. */
export function display(cells: Record<string, Cell>, at: string): string {
  return text(evaluate(cells, at));
}

export const isError = (value: string) => ERRORS.has(value);

/** Cells a formula mentions, so an editor can highlight them. */
export function referenced(formula: string): string[] {
  if (!formula.startsWith('=')) return [];
  const out = new Set<string>();
  for (const m of formula.toUpperCase().matchAll(/\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4})(?::\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4}))?/g)) {
    if (!m[3]) { out.add(`${m[1]}${m[2]}`); continue; }
    const a = parseRef(`${m[1]}${m[2]}`)!;
    const b = parseRef(`${m[3]}${m[4]}`)!;
    for (let y = Math.min(a.row, b.row); y <= Math.max(a.row, b.row); y++) {
      for (let x = Math.min(a.col, b.col); x <= Math.max(a.col, b.col); x++) out.add(ref(x, y));
    }
  }
  return [...out];
}
