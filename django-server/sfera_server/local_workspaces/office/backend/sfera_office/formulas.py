"""A small spreadsheet formula engine.

The browser evaluates the same grammar while you type (frontend/formula.ts);
this copy is what exports and printed views use, so a downloaded CSV shows the
numbers the author saw. Supported: numbers, strings, cell refs, ranges,
``+ - * / ^ %``, comparisons, and the functions below. Anything else gives
``#ERROR!``; a ref that points at itself gives ``#CYCLE!``.
"""
import re
from datetime import date

NUM_RE = re.compile(r'\d+(\.\d+)?')
REF_RE = re.compile(r'\$?([A-Z]{1,3})\$?([1-9][0-9]{0,4})')
NAME_RE = re.compile(r'[A-Z][A-Z0-9_.]*')
MAX_DEPTH = 24
ERROR = '#ERROR!'
CYCLE = '#CYCLE!'
DIV0 = '#DIV/0!'


class CalcError(Exception):
    def __init__(self, text=ERROR):
        super().__init__(text)
        self.text = text


def col_index(letters: str) -> int:
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def col_name(index: int) -> str:
    name = ''
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _num(value):
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return value
    if value in (None, ''):
        return 0
    if value in (ERROR, CYCLE, DIV0):
        # An error in a cell we depend on is our error too.
        raise CalcError(value)
    text = str(value).strip().replace(' ', '').replace(',', '.')
    try:
        return float(text)
    except ValueError:
        raise CalcError()


def _flat(args):
    for a in args:
        if isinstance(a, list):
            yield from _flat(a)
        else:
            yield a


def _numbers(args):
    out = []
    for a in _flat(args):
        if a in (None, ''):
            continue
        if isinstance(a, (int, float)) and not isinstance(a, bool):
            out.append(a)
            continue
        try:
            out.append(_num(a))
        except CalcError:
            continue
    return out


def _round(args):
    digits = int(_num(args[1])) if len(args) > 1 else 0
    return round(_num(args[0]), digits)


FUNCS = {
    'SUM': lambda a: sum(_numbers(a)),
    'AVERAGE': lambda a: (sum(_numbers(a)) / len(_numbers(a))) if _numbers(a) else 0,
    'AVG': lambda a: (sum(_numbers(a)) / len(_numbers(a))) if _numbers(a) else 0,
    'MIN': lambda a: min(_numbers(a)) if _numbers(a) else 0,
    'MAX': lambda a: max(_numbers(a)) if _numbers(a) else 0,
    'COUNT': lambda a: len(_numbers(a)),
    'COUNTA': lambda a: len([x for x in _flat(a) if x not in (None, '')]),
    'ROUND': _round,
    'ABS': lambda a: abs(_num(a[0])),
    'INT': lambda a: int(_num(a[0])),
    'SQRT': lambda a: _num(a[0]) ** 0.5,
    'POWER': lambda a: _num(a[0]) ** _num(a[1]),
    'PRODUCT': lambda a: _product(_numbers(a)),
    'IF': lambda a: a[1] if _truthy(a[0]) else (a[2] if len(a) > 2 else ''),
    'AND': lambda a: all(_truthy(x) for x in _flat(a)),
    'OR': lambda a: any(_truthy(x) for x in _flat(a)),
    'NOT': lambda a: not _truthy(a[0]),
    'CONCAT': lambda a: ''.join(_as_text(x) for x in _flat(a)),
    'CONCATENATE': lambda a: ''.join(_as_text(x) for x in _flat(a)),
    'LEN': lambda a: len(_as_text(a[0])),
    'UPPER': lambda a: _as_text(a[0]).upper(),
    'LOWER': lambda a: _as_text(a[0]).lower(),
    'TRIM': lambda a: _as_text(a[0]).strip(),
    'LEFT': lambda a: _as_text(a[0])[:int(_num(a[1])) if len(a) > 1 else 1],
    'RIGHT': lambda a: _as_text(a[0])[-(int(_num(a[1])) if len(a) > 1 else 1):],
    'TODAY': lambda a: date.today().isoformat(),
    'PERCENT': lambda a: _num(a[0]) / 100,
}


def _product(values):
    out = 1
    for v in values:
        out *= v
    return out


def _truthy(value):
    if isinstance(value, str):
        return value.strip().upper() not in ('', 'FALSE', '0', 'НЕТ')
    if isinstance(value, list):
        return any(_truthy(v) for v in value)
    return bool(_num(value)) if not isinstance(value, bool) else value


def _as_text(value):
    if value is None:
        return ''
    if isinstance(value, bool):
        return 'TRUE' if value else 'FALSE'
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    return str(value)


class _Parser:
    """Recursive descent over the formula text."""

    def __init__(self, text, lookup):
        self.s = text
        self.i = 0
        self.lookup = lookup

    def ws(self):
        while self.i < len(self.s) and self.s[self.i] in ' \t':
            self.i += 1

    def peek(self):
        self.ws()
        return self.s[self.i] if self.i < len(self.s) else ''

    def eat(self, token):
        self.ws()
        if self.s.startswith(token, self.i):
            self.i += len(token)
            return True
        return False

    def parse(self):
        value = self.comparison()
        self.ws()
        if self.i < len(self.s):
            raise CalcError()
        return value

    def comparison(self):
        left = self.additive()
        for token in ('<>', '<=', '>=', '=', '<', '>'):
            if self.eat(token):
                right = self.additive()
                if token in ('=', '<>'):
                    same = _as_text(left) == _as_text(right) if isinstance(left, str) or isinstance(right, str) else _num(left) == _num(right)
                    return same if token == '=' else not same
                a, b = _num(left), _num(right)
                return {'<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b}[token]
        return left

    def additive(self):
        value = self.multiplicative()
        while True:
            if self.eat('+'):
                value = _num(value) + _num(self.multiplicative())
            elif self.eat('-'):
                value = _num(value) - _num(self.multiplicative())
            elif self.eat('&'):
                value = _as_text(value) + _as_text(self.multiplicative())
            else:
                return value

    def multiplicative(self):
        value = self.power()
        while True:
            if self.eat('*'):
                value = _num(value) * _num(self.power())
            elif self.eat('/'):
                divisor = _num(self.power())
                if divisor == 0:
                    raise CalcError(DIV0)
                value = _num(value) / divisor
            else:
                return value

    def power(self):
        value = self.unary()
        if self.eat('^'):
            return _num(value) ** _num(self.power())
        return value

    def unary(self):
        if self.eat('-'):
            return -_num(self.unary())
        if self.eat('+'):
            return _num(self.unary())
        return self.postfix()

    def postfix(self):
        value = self.atom()
        if self.eat('%'):
            return _num(value) / 100
        return value

    def atom(self):
        self.ws()
        if self.eat('('):
            value = self.comparison()
            if not self.eat(')'):
                raise CalcError()
            return value
        ch = self.peek()
        if ch == '"':
            self.i += 1
            out = ''
            while self.i < len(self.s):
                c = self.s[self.i]
                self.i += 1
                if c == '"':
                    if self.i < len(self.s) and self.s[self.i] == '"':
                        out += '"'
                        self.i += 1
                        continue
                    return out
                out += c
            raise CalcError()
        m = NUM_RE.match(self.s, self.i)
        if m and (ch.isdigit() or ch == '.'):
            self.i = m.end()
            text = m.group(0)
            return float(text) if '.' in text else int(text)
        name = NAME_RE.match(self.s, self.i)
        if not name:
            raise CalcError()
        word = name.group(0)
        after = name.end()
        # A function call?
        rest = self.s[after:]
        if rest.lstrip().startswith('('):
            self.i = after + (len(rest) - len(rest.lstrip())) + 1
            args = []
            if not self.eat(')'):
                while True:
                    args.append(self.comparison())
                    if self.eat(','):
                        continue
                    if self.eat(';'):
                        continue
                    if self.eat(')'):
                        break
                    raise CalcError()
            func = FUNCS.get(word.upper())
            if func is None:
                raise CalcError()
            try:
                return func(args)
            except CalcError:
                raise
            except (IndexError, TypeError, ValueError, ZeroDivisionError, OverflowError):
                raise CalcError()
        # A range or a single ref.
        ref = REF_RE.match(self.s, self.i)
        if ref:
            self.i = ref.end()
            start = f'{ref.group(1)}{ref.group(2)}'
            if self.eat(':'):
                end_ref = REF_RE.match(self.s, self.i)
                if not end_ref:
                    raise CalcError()
                self.i = end_ref.end()
                return self.lookup(start, f'{end_ref.group(1)}{end_ref.group(2)}')
            return self.lookup(start, None)
        if word.upper() in ('TRUE', 'FALSE'):
            self.i = after
            return word.upper() == 'TRUE'
        raise CalcError()


def evaluate(cells: dict, ref: str, _stack=None, _cache=None):
    """Value of one cell: the literal, or the result of its formula."""
    cache = _cache if _cache is not None else {}
    if ref in cache:
        return cache[ref]
    stack = _stack or ()
    if ref in stack or len(stack) > MAX_DEPTH:
        return CYCLE
    raw = (cells.get(ref) or {}).get('v', '')
    if not isinstance(raw, str) or not raw.startswith('='):
        value = _literal(raw)
        cache[ref] = value
        return value

    def lookup(start, end):
        if end is None:
            return evaluate(cells, start, stack + (ref,), cache)
        c1, r1 = REF_RE.match(start).groups()
        c2, r2 = REF_RE.match(end).groups()
        x1, x2 = sorted((col_index(c1), col_index(c2)))
        y1, y2 = sorted((int(r1), int(r2)))
        if (x2 - x1 + 1) * (y2 - y1 + 1) > 20_000:
            raise CalcError()
        out = []
        for y in range(y1, y2 + 1):
            for x in range(x1, x2 + 1):
                out.append(evaluate(cells, f'{col_name(x)}{y}', stack + (ref,), cache))
        return out

    try:
        value = _Parser(raw[1:], lookup).parse()
    except CalcError as e:
        value = e.text
    except RecursionError:
        value = CYCLE
    if isinstance(value, list):
        value = value[0] if value else ''
    if isinstance(value, float) and value == int(value) and abs(value) < 1e15:
        value = int(value)
    cache[ref] = value
    return value


def _literal(raw):
    if raw in (None, ''):
        return ''
    text = str(raw).strip()
    try:
        number = float(text.replace(' ', '').replace(',', '.'))
    except ValueError:
        return raw
    return int(number) if number == int(number) and abs(number) < 1e15 else number


def display(cells: dict, ref: str) -> str:
    """What a cell shows, as text."""
    return _as_text(evaluate(cells, ref))
