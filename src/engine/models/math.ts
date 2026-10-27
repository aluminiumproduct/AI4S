export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
export const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
export const squaredDistance = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0);
export const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i], 0);
/** Cholesky factorization; never forms an inverse. */
export function cholesky(matrix: number[][]): number[][] {
  const lower = matrix.map(row => row.map(() => 0));
  for (let i = 0; i < matrix.length; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[i][j];
    for (let k = 0; k < j; k++) value -= lower[i][k] * lower[j][k];
    if (i === j) {
      if (!(value > 0) || !Number.isFinite(value)) throw new Error("Matrix is not positive definite");
      lower[i][j] = Math.sqrt(value);
    } else lower[i][j] = value / lower[j][j];
  }
  return lower;
}
export function forwardSolve(lower: number[][], rhs: number[]): number[] {
  const result = rhs.slice();
  for (let i = 0; i < result.length; i++) {
    for (let j = 0; j < i; j++) result[i] -= lower[i][j] * result[j];
    result[i] /= lower[i][i];
  }
  return result;
}
export function solveCholesky(lower: number[][], rhs: number[]): number[] {
  const result = forwardSolve(lower, rhs);
  for (let i = result.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < result.length; j++) result[i] -= lower[j][i] * result[j];
    result[i] /= lower[i][i];
  }
  return result;
}
