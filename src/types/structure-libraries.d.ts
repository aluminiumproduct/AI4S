declare module "crystcif-parse/lib/parse.js" {
  export interface CifValue { type: string; get_value(): string | number | undefined; }
  export interface CifItem { tag: string; type: "single" | "loop"; value: CifValue | CifValue[]; }
  export function parseCif(text: string): Record<string, Record<string, CifItem>>;
}
