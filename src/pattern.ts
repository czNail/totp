/** Android-style 3×3 paths, numbered left-to-right from 1 through 9. */
export function appendPoint(path: readonly number[], next: number): number[] {
  if (!Number.isInteger(next) || next < 1 || next > 9) throw new Error('手势点无效。');
  if (path.includes(next)) return [...path];
  const result = [...path];
  const previous = path.at(-1);
  if (previous !== undefined) {
    const a = previous - 1;
    const b = next - 1;
    const row = (Math.floor(a / 3) + Math.floor(b / 3)) / 2;
    const column = (a % 3 + b % 3) / 2;
    if (Number.isInteger(row) && Number.isInteger(column)) {
      const middle = row * 3 + column + 1;
      if (middle !== previous && middle !== next && !result.includes(middle)) result.push(middle);
    }
  }
  result.push(next);
  return result;
}
export function normalizePattern(input: string): string {
  if (!/^[1-9]{1,9}$/.test(input) || new Set(input).size !== input.length) throw new Error('请连接 4–9 个不同的点。');
  const path = Array.from(input, Number).reduce<number[]>((points, point) => appendPoint(points, point), []);
  if (path.length < 4) throw new Error('手势太短，请至少连接 4 个点。');
  return path.join('');
}
