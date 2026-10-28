import type { Dimension, Expression, PhysicalFeature } from "./types";

const same = (a: Dimension, b: Dimension) => a.every((value, i) => value === b[i]);
export function expressionDimension(expression: Expression, features: PhysicalFeature[]): Dimension | null {
  if (expression.op === "variable") return features[expression.index]?.dimension ?? null;
  if (expression.op === "one") return [0, 0];
  if ("arg" in expression) {
    const value = expressionDimension(expression.arg, features);
    if (!value) return null;
    if (expression.op === "exp") return same(value, [0, 0]) ? [0, 0] : null;
    return expression.op === "sqrt" ? [value[0] / 2, value[1] / 2] : value;
  }
  const left = expressionDimension(expression.left, features), right = expressionDimension(expression.right, features);
  if (!left || !right) return null;
  if (expression.op === "+" || expression.op === "-") return same(left, right) ? left : null;
  return [left[0] + (expression.op === "*" ? right[0] : -right[0]), left[1] + (expression.op === "*" ? right[1] : -right[1])];
}
export function evaluateExpression(expression: Expression, values: (number | null)[]): number | null {
  if (expression.op === "variable") {
    const value = values[expression.index];
    return value !== null && Number.isFinite(value) ? value : null;
  }
  if (expression.op === "one") return 1;
  if ("arg" in expression) {
    const value = evaluateExpression(expression.arg, values);
    if (value === null) return null;
    if (expression.op === "sqrt" && value < 0 || expression.op === "exp" && Math.abs(value) > 12) return null;
    const result = expression.op === "abs" ? Math.abs(value) : expression.op === "sqrt" ? Math.sqrt(value) : Math.exp(value);
    return Number.isFinite(result) && Math.abs(result) <= 1e12 ? result : null;
  }
  const a = evaluateExpression(expression.left, values), b = evaluateExpression(expression.right, values);
  if (a === null || b === null || expression.op === "/" && Math.abs(b) <= (expression.floor ?? 1e-10)) return null;
  const result = expression.op === "+" ? a + b : expression.op === "-" ? a - b : expression.op === "*" ? a * b : a / b;
  return Number.isFinite(result) && Math.abs(result) <= 1e12 ? result : null;
}
export function expressionSize(expression: Expression): number {
  return "arg" in expression ? 1 + expressionSize(expression.arg) : "left" in expression
    ? 1 + expressionSize(expression.left) + expressionSize(expression.right) : 1;
}
export function expressionDepth(expression: Expression): number {
  return "arg" in expression ? 1 + expressionDepth(expression.arg) : "left" in expression
    ? 1 + Math.max(expressionDepth(expression.left), expressionDepth(expression.right)) : 1;
}
export function expressionKey(expression: Expression): string {
  if (expression.op === "variable") return "x" + expression.index;
  if (expression.op === "one") return "1";
  if ("arg" in expression) return expression.op + "(" + expressionKey(expression.arg) + ")";
  return "(" + expressionKey(expression.left) + expression.op + expressionKey(expression.right) + ")";
}
export function formatExpression(expression: Expression, features: PhysicalFeature[], latex = false): string {
  if (expression.op === "variable") return latex ? "\\mathrm{" + features[expression.index].id.replaceAll("_", "\\_") + "}" : features[expression.index].symbol;
  if (expression.op === "one") return "1";
  if ("arg" in expression) {
    const argument = formatExpression(expression.arg, features, latex);
    if (expression.op === "abs") return latex ? "\\left|" + argument + "\\right|" : "|" + argument + "|";
    if (expression.op === "sqrt") return latex ? "\\sqrt{" + argument + "}" : "√(" + argument + ")";
    return (latex ? "\\exp" : "exp") + "(" + argument + ")";
  }
  const a = formatExpression(expression.left, features, latex), b = formatExpression(expression.right, features, latex);
  return latex && expression.op === "/" ? "\\frac{" + a + "}{" + b + "}"
    : "(" + a + (expression.op === "*" ? latex ? "\\cdot " : " × " : " " + expression.op + " ") + b + ")";
}
export function dimensionText(dimension: Dimension): string {
  const parts = [dimension[0] ? "eV" + (dimension[0] === 1 ? "" : "^" + dimension[0]) : "",
    dimension[1] ? "Å" + (dimension[1] === 1 ? "" : "^" + dimension[1]) : ""].filter(Boolean);
  return parts.join(" · ") || "1";
}
