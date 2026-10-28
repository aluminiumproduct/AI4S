import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Download, FlaskConical, Layers3, Pause, Play, RotateCcw, SlidersHorizontal, Sparkles, Target, TrendingUp, Wallet } from "lucide-react";
import type { Material } from "../types";
import { ModelWorkerClient } from "../engine/ModelWorkerClient";
import { demoCandidates, materialCandidates, PARETO_SCALES, parseStabilityInputs, type StabilityInput } from "../engine/pareto/ParetoData";
import { INITIAL_PARETO_STATE, normalizeWeights, paretoFront, preferredCandidate, runParetoStep, type ParetoCandidate, type ParetoState, type Weights } from "../engine/pareto/ParetoEngine";
import { PRICE_BOOK, PRICE_BOOK_VERSION, atomicMass, parsePriceOverrides, type PriceOverrides } from "../engine/pareto/priceBook";
import { ELEMENT_TABLE_VERSION } from "../engine/CompositionFeatures";
import "./pareto.css";

const number = (n: number, digits = 2) => n.toLocaleString("en-US", { maximumFractionDigits: digits });
const presets: { id: string; zh: string; en: string; weights: Weights }[] = [
  { id: "flagship", zh: "性能旗舰", en: "Performance flagship", weights: [90, 7, 3] },
  { id: "balanced", zh: "均衡优选", en: "Balanced choice", weights: [50, 25, 25] },
  { id: "value", zh: "成本优先", en: "Cost leadership", weights: [35, 15, 50] },
];

export default function ParetoExplorer({ materials, lang }: { materials: Material[]; lang: "zh" | "en" }) {
  const zh = lang === "zh";
  const [mode, setMode] = useState<"demo" | "materials-project">("demo");
  const [weights, setWeights] = useState<Weights>([50, 25, 25]);
  const [budget, setBudget] = useState(30);
  const [seed, setSeed] = useState(42);
  const [strategy, setStrategy] = useState<"ParEGO" | "Random">("ParEGO");
  const [prices, setPrices] = useState<PriceOverrides>({});
  const [priceText, setPriceText] = useState(JSON.stringify(Object.fromEntries(["Al", "Co", "Ni", "Cu", "Ge", "Sc"].map(s => [s, Number(PRICE_BOOK[s].usdKg.toFixed(4))])), null, 2));
  const [stabilityText, setStabilityText] = useState("[]");
  const [externalStability, setExternalStability] = useState<StabilityInput[]>([]);
  const [settingsError, setSettingsError] = useState("");
  const [pool, setPool] = useState<ParetoCandidate[]>([]);
  const [state, setState] = useState<ParetoState>(INITIAL_PARETO_STATE);
  const [phase, setPhase] = useState<"idle" | "running" | "paused" | "done" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replay, setReplay] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const client = useRef<ModelWorkerClient | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const busyRef = useRef(false);
  // Parent predictions and sampled flags change each round; only raw dataset changes reset this engine.
  const materialSignature = useMemo(() => JSON.stringify(materials.map(m => [m.id, m.source, m.trueProperty, m.energyAboveHull, m.composition])), [materials]);
  const datasetSignature = mode === "demo" ? "demo" : materialSignature;
  const dataset = useMemo(() => mode === "demo"
    ? { candidates: demoCandidates(prices), missingStability: 0, missingPrice: 0 }
    : materialCandidates(materials, prices, externalStability), [mode, datasetSignature, prices, externalStability]);
  const scales = PARETO_SCALES[mode];
  const hasMP = materials.some(m => m.source === "materials-project");
  const stopWork = () => {
    generation.current++;
    controller.current?.abort(); controller.current = null;
    client.current?.cancel(); busyRef.current = false; setBusy(false);
  };
  const reset = () => {
    stopWork(); setPool(dataset.candidates.map(c => ({ ...c, observed: false, observedAt: undefined })));
    setState(INITIAL_PARETO_STATE()); setPhase("idle"); setError(""); setReplay(null); setHoveredId(null);
  };
  useEffect(() => { reset(); }, [dataset]);
  useEffect(() => () => { generation.current++; controller.current?.abort(); client.current?.dispose(); }, []);

  useEffect(() => {
    if (phase !== "running" || busy || busyRef.current) return;
    const version = generation.current;
    const timer = setTimeout(async () => {
      if (version !== generation.current || busyRef.current) return;
      busyRef.current = true; setBusy(true);
      const active = new AbortController(); controller.current = active;
      try {
        if (!client.current) client.current = new ModelWorkerClient({ kind: "gpr", seed });
        const result = await runParetoStep(pool, state, { budget, seed, weights, scales, strategy, signal: active.signal }, client.current);
        if (version !== generation.current) return;
        setPool(result.pool); setState(result.state); setReplay(null);
        if (result.done) setPhase("done");
      } catch (e) {
        if (version !== generation.current) return;
        setError(e instanceof Error ? e.message : String(e)); setPhase("error");
      } finally {
        if (version === generation.current) { busyRef.current = false; setBusy(false); controller.current = null; }
      }
    }, state.round === 0 ? 50 : 380);
    return () => clearTimeout(timer);
  }, [phase, busy, pool, state, budget, seed, weights, scales, strategy]);

  const viewPool = replay === null ? pool : pool.map(c => ({ ...c, observed: c.observed && (c.observedAt ?? Infinity) <= replay }));
  const observed = viewPool.filter(c => c.observed);
  const front = paretoFront(viewPool);
  const selected = preferredCandidate(viewPool, weights, scales);
  const hover = observed.find(c => c.id === hoveredId);
  const preference = normalizeWeights(weights);
  const currentRecord = replay === null ? state.history.at(-1) : state.history.find(h => h.round === replay);
  const topPerformance = observed.length ? Math.max(...observed.map(c => c.objectives[0])) : 0;
  const byPreference = [...front].sort((a, b) => a.objectives[0] - b.objectives[0]);
  const plotPerformance = Math.max(scales.performance, ...observed.map(c => c.objectives[0]));
  const plotPrice = Math.max(scales.price, ...observed.map(c => c.objectives[2]));
  const x = (c: ParetoCandidate) => 82 + 744 * Math.max(0, c.objectives[0] / plotPerformance);
  const y = (c: ParetoCandidate) => 333 - 266 * (1 - Math.log1p(c.objectives[2]) / Math.log1p(plotPrice));
  const color = (c: ParetoCandidate) => c.objectives[1] <= 0.04 ? "#bdf17a" : c.objectives[1] <= 0.1 ? "#72d4d1" : "#f1bb79";
  const line = byPreference.map((c, i) => `${i ? "L" : "M"}${x(c)},${y(c)}`).join(" ");
  const initialHV = state.history[0]?.hypervolume ?? 0;
  const gain = initialHV > 0 && currentRecord ? (currentRecord.hypervolume / initialHV - 1) * 100 : 0;
  const perfUnit = mode === "demo" ? (zh ? "分" : "pts") : "eV";
  const exportFront = () => {
    const output = { schema: "ai4s-pareto-1", algorithm: strategy, mode, seed, budget, scales, preference, priceBookVersion: PRICE_BOOK_VERSION,
      priceReferences: PRICE_BOOK, priceOverrides: prices, elementTableVersion: ELEMENT_TABLE_VERSION,
      surrogateConfig: client.current ? { ...client.current.config } : null,
      atomicMasses: Object.fromEntries([...new Set(observed.flatMap(c => Object.keys(c.composition)))].map(s => [s, atomicMass(s)])),
      externalStability, viewRound: replay ?? state.round, lastCompletedRound: state.round, plotScales: { performance: plotPerformance, price: plotPrice },
      history: state.history.filter(h => h.round <= (replay ?? state.round)),
      observed: observed.map(({ features, ...candidate }) => candidate), selectedId: selected?.id, exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "AI4S-Pareto-front.json"; a.click(); URL.revokeObjectURL(url);
  };

  return <section id="pareto-explorer" className="pareto-shell" aria-labelledby="pareto-heading">
    <div className="pareto-eyebrow"><span className="pareto-live-dot" /> MULTI-OBJECTIVE INTELLIGENCE <span className="pareto-version">{strategy} · 3 {zh ? "目标联合寻优" : "objectives"}</span></div>
    <div className="pareto-title-row"><div><h2 id="pareto-heading">{zh ? <>高性能，<em>也要好生意。</em></> : <>High performance.<em> Better economics.</em></>}</h2><p>{zh ? "让性能、相稳定性与原料成本，在同一张决策图上找到交汇点。" : "Find the intersection of performance, phase stability and material economics."}</p></div><div className="pareto-source-switch" aria-label={zh ? "多目标数据源" : "Multi-objective data source"}><button aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>{zh ? "路演组合" : "Demo alloys"}</button><button aria-pressed={mode === "materials-project"} disabled={!hasMP} onClick={() => setMode("materials-project")}>Materials Project</button></div></div>
    <div className="pareto-toolbar">
      <div className="pareto-tags"><span><FlaskConical size={13} />{mode === "demo" ? (zh ? "确定性演示 · Al / Co / Ni / Cu / Ge / Sc" : "Deterministic demo · six metals") : (zh ? "MP 数据库回放" : "MP database replay")}</span><span>{dataset.candidates.length} {zh ? "候选" : "candidates"}</span><span>2025e {zh ? "价格快照 / 企业情景" : "price references / scenarios"}</span></div>
      <div className="pareto-actions"><button onClick={exportFront} disabled={!observed.length} aria-label={zh ? "导出帕累托前沿" : "Export Pareto frontier"}><Download size={15}/><span>{zh ? "导出" : "Export"}</span></button><button onClick={reset} aria-label={zh ? "重置多目标寻优" : "Reset multi-objective search"}><RotateCcw size={15}/><span>{zh ? "重置" : "Reset"}</span></button><button className="pareto-run" disabled={!pool.length || phase === "done"} onClick={() => { if (phase === "running") { stopWork(); setPhase("paused"); } else { setError(""); setReplay(null); setPhase("running"); } }}>{phase === "running" ? <Pause size={15}/> : <Play size={15}/>}<span>{phase === "running" ? (zh ? "暂停寻优" : "Pause search") : phase === "done" ? (zh ? "本轮寻优完成" : "Search complete") : phase === "paused" || phase === "error" ? (zh ? "继续寻优" : "Resume search") : (zh ? "开启协同寻优" : "Start co-optimization")}</span></button></div>
    </div>
    <div className="pareto-metrics"><div><span>{zh ? "已评价候选" : "Evaluated candidates"}</span><strong>{observed.length}<small> / {Math.min(budget, pool.length)}</small></strong></div><div><span>{zh ? "帕累托优选" : "Pareto choices"}</span><strong>{front.length}<small> {zh ? "个方案" : "designs"}</small></strong></div><div><span>{zh ? "最优功能表现" : "Best performance"}</span><strong>{observed.length ? number(topPerformance, 3) : "—"}<small> {perfUnit}</small></strong></div><div><span>{zh ? "超体积增长" : "Hypervolume growth"}</span><strong className="pareto-green">{currentRecord ? `${gain >= 0 ? "+" : ""}${number(gain, 1)}%` : "—"}<small> HV {number(currentRecord?.hypervolume ?? 0, 3)}</small></strong></div></div>
    <div className="pareto-workspace"><div className="pareto-chart-area"><div className="pareto-chart-title"><div><h3><TrendingUp size={17}/>{zh ? "动态帕累托前沿" : "Evolving Pareto frontier"}</h3><p>{zh ? "越向右，性能越强；越向上，原料成本越低。点色映射相稳定性。" : "Right: stronger performance. Up: lower material cost. Color: phase stability."}</p></div><span className={`pareto-state ${phase === "running" ? "is-running" : ""}`}>{busy ? (zh ? "模型计算中" : "Computing") : phase === "running" ? (zh ? "前沿生长中" : "Frontier growing") : `${zh ? "第" : "Round"} ${replay ?? state.round} ${zh ? "轮" : ""}`}</span></div>
      <svg className="pareto-chart" viewBox="0 0 940 410" role="img" aria-label={zh ? "已观测三目标帕累托前沿投影" : "Observed three-objective Pareto frontier projection"}>
        <defs><linearGradient id="pareto-chart-bg" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#142d2a"/><stop offset="1" stopColor="#10201f"/></linearGradient><filter id="pareto-glow"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
        <rect x="0" y="0" width="940" height="410" rx="16" fill="url(#pareto-chart-bg)"/>
        {[0, 0.25, 0.5, 0.75, 1].map(t => <g key={t}><path d={`M82 ${333 - 266 * t}H826M${82 + 744 * t} 67V333`} stroke="#d4f6de" strokeOpacity="0.08" strokeDasharray="3 7"/><text x={82 + 744 * t} y="355" textAnchor="middle">{number(plotPerformance * t, 1)}</text><text x="67" y={337 - 266 * t} textAnchor="end">${number(Math.expm1((1 - t) * Math.log1p(plotPrice)), 0)}</text></g>)}
        <text x="450" y="389" textAnchor="middle">{mode === "demo" ? (zh ? "功能指数（分）→" : "Performance index (pts) →") : (zh ? "数据库带隙（eV）→" : "Database band gap (eV) →")}</text><text x="31" y="40">{zh ? "采购成本 / USD·kg⁻¹" : "Material price / USD·kg⁻¹"}</text>
        {observed.map(c => <circle key={`history-${c.id}`} cx={x(c)} cy={y(c)} r="3.5" fill="#b1c6bd" opacity="0.3"/>)}
        <path d={line} className="pareto-front-line" fill="none" stroke="#c1f080" strokeWidth="2" filter="url(#pareto-glow)"/>
        {byPreference.map(c => <g key={c.id} onMouseEnter={() => setHoveredId(c.id)} onMouseLeave={() => setHoveredId(null)}><circle cx={x(c)} cy={y(c)} r={selected?.id === c.id ? 10 : 5.5} fill={color(c)} stroke={selected?.id === c.id ? "#fff" : "#132c27"} strokeWidth={selected?.id === c.id ? 2.5 : 1.5}/><title>{c.formula} · {number(c.objectives[0], 3)} {perfUnit} · {number(c.objectives[1] * 1000, 1)} meV/atom · ${number(c.objectives[2])}/kg</title></g>)}
        {selected && <g><rect x={Math.min(716, x(selected) + 16)} y={Math.max(50, y(selected) - 23)} width="112" height="30" rx="7" fill="#c7f29b"/><text className="pareto-svg-selection" x={Math.min(772, x(selected) + 72)} y={Math.max(69, y(selected) - 4)} textAnchor="middle">{selected.formula}</text></g>}
        {!observed.length && <g><text className="pareto-svg-empty" x="470" y="177" textAnchor="middle">{pool.length ? (zh ? "下一条增长曲线，从这里开始" : "Your next frontier starts here") : (zh ? "为候选补充稳定性与价格，即可启程" : "Add stability and price inputs to begin")}</text><text x="470" y="205" textAnchor="middle">{pool.length ? (zh ? "点击「开启协同寻优」，让模型逐轮发现最优折中" : "Start co-optimization to reveal the frontier") : `${zh ? "缺稳定性" : "Missing stability"}: ${dataset.missingStability} · ${zh ? "缺价格" : "Missing prices"}: ${dataset.missingPrice}`}</text></g>}
      </svg>
      <div className="pareto-chart-footer"><span><i style={{ background: "#bdf17a" }}/>{zh ? "≤40 meV/atom" : "≤40 meV/atom"}</span><span><i style={{ background: "#72d4d1" }}/>40–100 meV/atom</span><span><i style={{ background: "#f1bb79" }}/>&gt;100 meV/atom</span><strong>{hover ? `${hover.formula} · $${number(hover.objectives[2])}/kg` : (zh ? "三目标非支配点 · 性能×成本投影" : "3-objective non-dominated points · projection")}</strong></div>
      {state.history.length > 0 && <div className="pareto-timeline"><span>{zh ? "演进回放" : "Replay"}</span><input type="range" aria-label={zh ? "帕累托演进回放" : "Pareto evolution replay"} min="1" max={state.round} value={replay ?? state.round} disabled={phase === "running"} onChange={e => setReplay(Number(e.target.value) === state.round ? null : Number(e.target.value))}/><b>{replay ?? state.round}/{state.round}</b><svg viewBox="0 0 150 28" aria-label="Hypervolume history"><polyline fill="none" stroke="#a9dc79" strokeWidth="2" points={state.history.map((h, i) => `${3 + i / Math.max(1, state.history.length - 1) * 143},${25 - h.hypervolume / Math.max(0.001, ...state.history.map(r => r.hypervolume)) * 22}`).join(" ")}/></svg></div>}
    </div><aside className="pareto-preferences"><h3><SlidersHorizontal size={17}/>{zh ? "企业偏好驾驶舱" : "Business preference cockpit"}</h3><p>{zh ? "同一条前沿，切换你的商业答案。" : "One frontier. Your business priorities."}</p><div className="pareto-presets">{presets.map(p => <button key={p.id} onClick={() => setWeights([...p.weights])} aria-pressed={weights.every((w, i) => w === p.weights[i])}>{zh ? p.zh : p.en}</button>)}</div>
      {[{ zh: "性能领先", en: "Performance", icon: Target }, { zh: "相稳定性", en: "Phase stability", icon: Layers3 }, { zh: "降本空间", en: "Material economics", icon: Wallet }].map((item, i) => <label className="pareto-weight" key={item.en}><span><item.icon size={14}/>{zh ? item.zh : item.en}<b>{Math.round(preference[i] * 100)}%</b></span><input type="range" aria-label={zh ? item.zh : item.en} min="0" max="100" value={weights[i]} onChange={e => setWeights(old => old.map((w, j) => i === j ? Number(e.target.value) : w) as Weights)}/></label>)}
      <div className="pareto-pick" aria-live="polite"><span className="pareto-pick-eyebrow"><Sparkles size={13}/>{zh ? "此刻优选" : "YOUR CURRENT CHOICE"}</span><h4>{selected?.formula ?? "—"}</h4><p className="pareto-pick-id">{selected?.id ?? (zh ? "完成首轮评价后，即刻生成方案" : "Evaluate the first batch to reveal a choice")}</p>{selected && <div className="pareto-pick-values"><div><span>{zh ? "功能表现" : "Performance"}</span><b>{number(selected.objectives[0], 3)} <small>{perfUnit}</small></b></div><div><span>E<sub>hull</sub></span><b>{number(selected.objectives[1] * 1000, 1)} <small>meV/atom</small></b></div><div><span>{zh ? "原料成本" : "Material price"}</span><b>${number(selected.objectives[2])}<small> /kg</small></b></div></div>}<span className="pareto-pick-footer">{selected ? <><ArrowUpRight size={14}/>{zh ? "已观测帕累托优选" : "Observed Pareto-optimal choice"}</> : (zh ? "让每一轮数据，变成可执行的选择" : "Turn every observation into a decision")}</span></div>
    </aside></div>
    {error && <p className="pareto-error" role="alert">{zh ? "本轮计算需要重试：" : "Retry this round: "}{error}</p>}
    <details className="pareto-settings"><summary><SlidersHorizontal size={14}/>{zh ? "实验设置、原料报价与稳定性接入" : "Experiment settings, prices & stability inputs"}</summary><div className="pareto-settings-grid"><div><label>{zh ? "评价预算" : "Evaluation budget"}<input type="number" min="6" max="200" value={budget} disabled={state.round > 0} onChange={e => { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n >= 6 && n <= 200) setBudget(n); }}/></label><label>{zh ? "搜索种子" : "Search seed"}<input type="number" min="0" max="4294967295" value={seed} disabled={state.round > 0} onChange={e => { const n = Number(e.target.value); if (Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff) { client.current?.dispose(); client.current = null; setSeed(n); } }}/></label><label>{zh ? "采样策略" : "Sampling strategy"}<select value={strategy} disabled={state.round > 0} onChange={e => setStrategy(e.target.value as "ParEGO" | "Random")}><option>ParEGO</option><option value="Random">{zh ? "随机基线" : "Random baseline"}</option></select></label><p>{zh ? "ParEGO每轮重新标量化三目标观测，使用后台GPR与EI选择下一候选。偏好选择即时生效，跨轮HV使用固定尺度。" : "ParEGO re-scalarizes observations each round and uses Worker GPR/EI. Preferences update choices instantly; HV uses fixed scales."}</p></div><div><label htmlFor="pareto-price-input">{zh ? "企业报价覆盖 / USD·kg⁻¹" : "Company price overrides / USD·kg⁻¹"}</label><textarea id="pareto-price-input" rows={5} value={priceText} onChange={e => setPriceText(e.target.value)}/><button onClick={() => { try { const value = parsePriceOverrides(priceText); setSettingsError(""); setPrices(value); } catch (e) { setSettingsError(String(e)); } }}>{zh ? "应用报价并重启" : "Apply prices & restart"}</button><details><summary>{zh ? "查看价格来源与计量口径" : "Price sources & basis"}</summary><p>{PRICE_BOOK_VERSION} · {zh ? "质量分数加权原料价格；企业覆盖值作为采购情景。" : "Mass-weighted material price; overrides define company scenarios."}</p>{Object.entries(PRICE_BOOK).map(([s, p]) => <p key={s}><b>{s}</b> · ${number(prices[s] ?? p.usdKg, 4)}/kg · {p.basis} {p.quality === "reference" && <a href={p.source} target="_blank" rel="noreferrer">USGS ↗</a>}</p>)}</details></div><div><label htmlFor="pareto-stability-input">{zh ? "外部稳定性结果 / Ehull · eV/atom" : "External hull results / eV/atom"}</label><textarea id="pareto-stability-input" rows={5} value={stabilityText} onChange={e => setStabilityText(e.target.value)}/><button onClick={() => { try { setExternalStability(parseStabilityInputs(stabilityText)); setSettingsError(""); } catch (e) { setSettingsError(String(e)); } }}>{zh ? "接入稳定性结果" : "Import stability results"}</button><p>{zh ? "字段：materialId、energyAboveHull、source、method、referenceSet。按材料ID接入已有MLIP或DFT相稳定性评估。" : "Fields: materialId, energyAboveHull, source, method, referenceSet. Import existing MLIP or DFT phase-stability results by ID."}</p></div></div>{settingsError && <p role="alert" className="pareto-error">{settingsError}</p>}</details>
  </section>;
}
