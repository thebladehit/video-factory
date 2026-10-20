/**
 * Мінімальний інтерпретатор ffmpeg-сумісних виразів (числа, + - * /, дужки, min, max, змінні).
 * Для тестів паритету: вираз для ffmpeg має давати те саме число, що й закон для canvas.
 */
export function evalExpr(src: string, vars: Record<string, number>): number {
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === ' ') i++;
  };
  const expect_ = (c: string) => {
    skip();
    if (src[i] !== c) throw new Error(`expected ${c} at ${i} in ${src}`);
    i++;
  };
  function primary(): number {
    skip();
    const c = peek();
    if (c === '(') {
      i++;
      const v = sum();
      expect_(')');
      return v;
    }
    if (c === '-') {
      i++;
      return -primary();
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const name = /^[a-zA-Z_]\w*/.exec(src.slice(i));
    if (!name) throw new Error(`unexpected ${c} at ${i} in ${src}`);
    i += name[0].length;
    if (name[0] === 'min' || name[0] === 'max') {
      expect_('(');
      const a = sum();
      expect_(',');
      const b = sum();
      expect_(')');
      return name[0] === 'min' ? Math.min(a, b) : Math.max(a, b);
    }
    if (!(name[0] in vars)) throw new Error(`unknown ${name[0]}`);
    return vars[name[0]]!;
  }
  function product(): number {
    let v = primary();
    for (;;) {
      skip();
      if (peek() === '*') {
        i++;
        v *= primary();
      } else if (peek() === '/') {
        i++;
        v /= primary();
      } else return v;
    }
  }
  function sum(): number {
    let v = product();
    for (;;) {
      skip();
      if (peek() === '+') {
        i++;
        v += product();
      } else if (peek() === '-') {
        i++;
        v -= product();
      } else return v;
    }
  }
  const v = sum();
  skip();
  if (i !== src.length) throw new Error(`trailing input at ${i} in ${src}`);
  return v;
}
