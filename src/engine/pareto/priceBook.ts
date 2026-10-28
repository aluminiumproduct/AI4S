import { getElementConstants } from "../CompositionFeatures";

export interface PriceReference {
  mass: number;
  usdKg: number;
  basis: string;
  source: string;
  quality: "reference" | "scenario";
}
const usgs = (commodity: string) => `https://pubs.usgs.gov/periodicals/mcs2026/mcs2026-${commodity}.pdf`;
const poundsPerKg = 1 / 0.45359237;
const scenario = (mass: number, usdKg: number): PriceReference => ({ mass, usdKg,
  basis: "企业价格情景，可按采购条件调整", source: "user-editable scenario", quality: "scenario" });

/** 2025 estimated annual references from USGS MCS 2026; USD per kg of the stated commodity. */
export const PRICE_BOOK: Record<string, PriceReference> = {
  Al: { mass: 26.9815385, usdKg: 1.8 * poundsPerKg, basis: "2025e，美国铝锭现货，180美分/磅", source: usgs("aluminum"), quality: "reference" },
  Co: { mass: 58.933194, usdKg: 21 * poundsPerKg, basis: "2025e，美国阴极钴现货，21美元/磅", source: usgs("cobalt"), quality: "reference" },
  Ni: { mass: 58.6934, usdKg: 15, basis: "2025e，LME镍现货，15000美元/吨", source: usgs("nickel"), quality: "reference" },
  Cu: { mass: 63.546, usdKg: 4.8 * poundsPerKg, basis: "2025e，COMEX高等级铜，480美分/磅", source: usgs("copper"), quality: "reference" },
  Ge: { mass: 72.63, usdKg: 4100, basis: "2025e，欧洲金属锗，最低99.999%纯度，4100美元/kg", source: usgs("germanium"), quality: "reference" },
  Sc: { mass: 44.955908, usdKg: 5200, basis: "2025e，99.999%钪金属锭，1–10kg批量，5200美元/kg", source: usgs("scandium"), quality: "reference" },
  // These editable entries are scenarios, never represented as quoted market prices.
  Li: scenario(6.94, 48), O: { ...scenario(15.999, 0), basis: "氧不单独计价的原料情景；可按工艺修改" },
  Fe: scenario(55.845, 1), Mn: scenario(54.938044, 2), H: scenario(1.008, 2),
  B: scenario(10.81, 5), C: scenario(12.011, 1), P: scenario(30.973762, 3), S: scenario(32.06, 0.2),
  F: scenario(18.998403, 2), La: scenario(138.90547, 10), Zr: scenario(91.224, 35),
  Ti: scenario(47.867, 10), Sr: scenario(87.62, 4), Ba: scenario(137.327, 2), Sn: scenario(118.71, 30),
};
export type PriceOverrides = Record<string, number>;
export const PRICE_BOOK_VERSION = "usgs-mcs2026-2025e-v1";

export function atomicMass(symbol: string): number | null {
  return Object.hasOwn(PRICE_BOOK, symbol) ? PRICE_BOOK[symbol].mass : getElementConstants(symbol)?.atomicMass ?? null;
}
export function parsePriceOverrides(text: string): PriceOverrides {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([s, v]) =>
    !getElementConstants(s) || atomicMass(s) === null || typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
    throw new Error("请填写有效元素与非负价格");
  }
  return value;
}

export function materialPrice(composition: Record<string, number>, overrides: PriceOverrides = {}) {
  const entries = Object.entries(composition).filter(([, n]) => n !== 0);
  if (!entries.length || entries.some(([, n]) => !Number.isFinite(n) || n < 0)) throw new RangeError("Invalid composition for pricing");
  const missing = entries.filter(([symbol]) => atomicMass(symbol) === null
    || (!Object.hasOwn(PRICE_BOOK, symbol) && overrides[symbol] === undefined)).map(([symbol]) => symbol);
  if (missing.length) return { usdKg: null, missing, quality: "scenario" as const };
  const scale = Math.max(...entries.map(([, n]) => n));
  const masses = entries.map(([symbol, n]) => n / scale * atomicMass(symbol)!);
  const total = masses.reduce((sum, n) => sum + n, 0);
  const costs = entries.map(([symbol], i) => {
    const price = overrides[symbol] ?? PRICE_BOOK[symbol]?.usdKg;
    if (!Number.isFinite(price) || price < 0) throw new RangeError(`Invalid price for ${symbol}`);
    return masses[i] / total * price;
  });
  return { usdKg: costs.reduce((sum, n) => sum + n, 0), missing,
    quality: entries.some(([symbol]) => overrides[symbol] !== undefined || PRICE_BOOK[symbol]?.quality !== "reference") ? "scenario" as const : "reference" as const };
}
