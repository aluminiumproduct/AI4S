import table from "../data/element-constants.json" with { type: "json" };

export interface IonicRadius {
  oxidationState: number;
  coordination: string;
  coordinationNumber: number | null;
  spin: string;
  radiusAngstrom: number;
}

export interface ElementConstants {
  atomicNumber: number;
  name: string;
  electronegativityPauling: number | null;
  covalentRadiusAngstrom: number | null;
  neutralConfiguration: string | null;
  valenceElectrons: number | null;
  firstIonizationEnergyEv: number | null;
  electronAffinityEv: number | null;
  chemicalHardnessEv: number | null;
  referenceIon: IonicRadius | null;
  ionicRadii: IonicRadius[];
}

const elements = table.elements as unknown as Record<string, ElementConstants>;
export const ELEMENT_TABLE_VERSION = table.schemaVersion;
export const ELEMENT_DATA_SOURCES = table.provenance;
export const ELEMENT_SYMBOLS = Object.keys(elements).sort((a, b) => elements[a].atomicNumber - elements[b].atomicNumber);
export const FEATURE_SCHEMA_VERSION = "ai4s-composition-1.0.0";

export const PROPERTY_DEFINITIONS = [
  { key: "electronegativityPauling", label: "鲍林电负性", english: "Pauling electronegativity", unit: "1", scale: 4 },
  { key: "covalentRadiusAngstrom", label: "共价半径", english: "Covalent radius", unit: "Å", scale: 3 },
  { key: "referenceIonicRadiusAngstrom", label: "参考离子半径", english: "Reference ionic radius", unit: "Å", scale: 2 },
  { key: "valenceElectrons", label: "约定价电子数", english: "Valence electron count (convention)", unit: "e⁻", scale: 20 },
  { key: "chemicalHardnessEv", label: "原子化学硬度", english: "Atomic chemical hardness", unit: "eV", scale: 15 },
] as const;
export type PropertyKey = typeof PROPERTY_DEFINITIONS[number]["key"];
export interface WeightedStatistics {
  mean: number | null;
  variance: number | null;
  range: number | null;
  coverage: number;
  missingElements: string[];
}
export interface PerovskiteModel {
  a: string;
  b: string;
  aOxidation: number;
  bOxidation: number;
  aSpin?: string;
  bSpin?: string;
}
export interface ToleranceFactor {
  value: number | null;
  status: "reference-ABO3" | "not-ABO3" | "missing-radius" | "ambiguous-sites" | "charge-imbalance";
  model: { a: IonicRadius & { element: string }; b: IonicRadius & { element: string }; oxygen: IonicRadius } | null;
}
export interface CompositionDescriptors {
  schemaVersion: string;
  elementTableVersion: string;
  fractions: Record<string, number>;
  statistics: Record<PropertyKey, WeightedStatistics>;
  toleranceFactor: ToleranceFactor;
}

// Four entries per property (scaled mean, variance, range, coverage), then t and validity.
export const FEATURE_DEFINITIONS = [
  ...PROPERTY_DEFINITIONS.flatMap(property => [
    { id: `${property.key}.mean`, divisor: property.scale },
    { id: `${property.key}.variance`, divisor: property.scale ** 2 },
    { id: `${property.key}.range`, divisor: property.scale },
    { id: `${property.key}.coverage`, divisor: 1 },
  ]),
  { id: "toleranceFactor.value", divisor: 2 },
  { id: "toleranceFactor.valid", divisor: 1 },
];

export function getElementConstants(symbol: string): Readonly<ElementConstants> | undefined {
  return Object.hasOwn(elements, symbol) ? elements[symbol] : undefined;
}

export function normalizeComposition(composition: Record<string, number>): Record<string, number> {
  if (!composition || typeof composition !== "object" || Array.isArray(composition)) throw new TypeError("Composition must be an element-count object");
  const entries = Object.entries(composition).filter(([symbol, amount]) => {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) throw new RangeError(`Invalid amount for ${symbol}`);
    if (amount === 0) return false;
    if (!getElementConstants(symbol)) throw new RangeError(`Unknown element: ${symbol}`);
    return true;
  }).sort(([a], [b]) => elements[a].atomicNumber - elements[b].atomicNumber);
  if (entries.length === 0) throw new RangeError("Composition must contain a positive element amount");
  // Scale first so even large, finite stoichiometries cannot overflow the total.
  const maximum = Math.max(...entries.map(([, amount]) => amount));
  const total = entries.reduce((sum, [, amount]) => sum + amount / maximum, 0);
  return Object.fromEntries(entries.map(([symbol, amount]) => [symbol, (amount / maximum) / total]));
}

function valueFor(element: ElementConstants, property: PropertyKey): number | null {
  return property === "referenceIonicRadiusAngstrom" ? element.referenceIon?.radiusAngstrom ?? null : element[property];
}

function statistics(fractions: Record<string, number>, property: PropertyKey): WeightedStatistics {
  const entries = Object.entries(fractions).map(([symbol, fraction]) => ({ symbol, fraction, value: valueFor(elements[symbol], property) }));
  const missing = entries.filter(entry => entry.value === null);
  const coverage = entries.reduce((sum, entry) => sum + (entry.value === null ? 0 : entry.fraction), 0);
  if (missing.length > 0) return { mean: null, variance: null, range: null, coverage, missingElements: missing.map(entry => entry.symbol) };
  const mean = entries.reduce((sum, entry) => sum + entry.fraction * entry.value!, 0);
  const variance = entries.reduce((sum, entry) => sum + entry.fraction * (entry.value! - mean) ** 2, 0);
  const values = entries.map(entry => entry.value!);
  return { mean, variance, range: Math.max(...values) - Math.min(...values), coverage: 1, missingElements: [] };
}

function radius(symbol: string, oxidation: number, coordination: string, spin?: string): IonicRadius | undefined {
  const rows = elements[symbol].ionicRadii.filter(row => row.oxidationState === oxidation && row.coordination === coordination);
  if (spin) return rows.find(row => row.spin === spin);
  const referenceSpin = elements[symbol].referenceIon?.oxidationState === oxidation ? elements[symbol].referenceIon?.spin : undefined;
  return rows.find(row => row.spin === "unspecified") ?? rows.find(row => row.spin === referenceSpin);
}

export function calculateToleranceFactor(composition: Record<string, number>, requested?: PerovskiteModel): ToleranceFactor {
  const fractions = normalizeComposition(composition);
  const unavailable = (status: ToleranceFactor["status"]): ToleranceFactor => ({ value: null, status, model: null });
  const cations = Object.keys(fractions).filter(symbol => symbol !== "O");
  const formulaUnit = fractions.O / 3;
  if (cations.length !== 2 || !formulaUnit || !cations.every(symbol => Math.abs(fractions[symbol] / formulaUnit - 1) < 1e-8)) return unavailable("not-ABO3");
  if (requested && (requested.a === requested.b || !cations.includes(requested.a) || !cations.includes(requested.b))) return unavailable("not-ABO3");
  const candidates = requested ? [requested] : cations.map(a => {
    const b = cations.find(symbol => symbol !== a)!;
    return { a, b, aOxidation: elements[a].referenceIon?.oxidationState, bOxidation: elements[b].referenceIon?.oxidationState };
  }).filter((entry): entry is PerovskiteModel => entry.aOxidation !== undefined && entry.bOxidation !== undefined);
  const neutral = candidates.filter(model => model.aOxidation + model.bOxidation === 6);
  if (neutral.length === 0) return unavailable("charge-imbalance");
  const oxygen = radius("O", -2, "VI")!;
  const valid = neutral.flatMap(model => {
    const a = radius(model.a, model.aOxidation, "XII", model.aSpin);
    const b = radius(model.b, model.bOxidation, "VI", model.bSpin);
    if (!a || !b || a.radiusAngstrom <= 0 || b.radiusAngstrom <= 0) return [];
    return [{ a: { ...a, element: model.a }, b: { ...b, element: model.b }, oxygen }];
  });
  if (valid.length === 0) return unavailable("missing-radius");
  if (valid.length > 1) return unavailable("ambiguous-sites");
  const model = valid[0];
  return {
    value: (model.a.radiusAngstrom + oxygen.radiusAngstrom) / (Math.SQRT2 * (model.b.radiusAngstrom + oxygen.radiusAngstrom)),
    status: "reference-ABO3",
    model,
  };
}

/** Same deterministic featurizer for real records, Mock records and the live editor. */
export function extractCompositionFeatures(composition: Record<string, number>, perovskiteModel?: PerovskiteModel) {
  const fractions = normalizeComposition(composition);
  const summary = Object.fromEntries(PROPERTY_DEFINITIONS.map(property => [property.key, statistics(fractions, property.key)])) as Record<PropertyKey, WeightedStatistics>;
  const toleranceFactor = calculateToleranceFactor(fractions, perovskiteModel);
  const descriptors: CompositionDescriptors = { schemaVersion: FEATURE_SCHEMA_VERSION, elementTableVersion: ELEMENT_TABLE_VERSION, fractions, statistics: summary, toleranceFactor };
  const features = PROPERTY_DEFINITIONS.flatMap(property => {
    const stats = summary[property.key];
    // A zero placeholder is always paired with coverage; it is never presented as a measured value.
    return [(stats.mean ?? 0) / property.scale, (stats.variance ?? 0) / property.scale ** 2, (stats.range ?? 0) / property.scale, stats.coverage];
  });
  features.push((toleranceFactor.value ?? 0) / 2, toleranceFactor.value === null ? 0 : 1);
  return { features, descriptors };
}
