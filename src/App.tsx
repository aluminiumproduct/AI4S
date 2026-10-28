import React, { useState, useEffect, useMemo, useRef } from "react";
import { 
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, Cell
} from "recharts";
import { 
  Beaker, 
  Database, 
  Cpu, 
  Play, 
  RotateCcw, 
  ChevronRight, 
  AlertCircle,
  TrendingUp,
  Layers,
  Search,
  FileText,
  X,
  Palette,
  Zap,
  BarChart3,
  Sparkles
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { MaterialsEngine } from "./engine/MaterialsEngine";
import { ModelWorkerClient } from "./engine/ModelWorkerClient";
import type { ModelDiagnostics } from "./engine/SurrogateModel";
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "./engine/models/config";
import { seededRandom } from "./engine/models/math";
import { ModelControls } from "./components/ModelControls";
import type { AcquisitionStrategy } from "./engine/AcquisitionFunction";
import { getStopReason, runActiveLearningStep } from "./engine/ActiveLearningLoop";
import { Material, ALState, AL_CONFIG } from "./types";
import { BenchmarkSimulator } from "./components/BenchmarkSimulator";
import { networkMessage, type NetworkIssueCode } from "./services/NetworkStatus";
import MaterialsAdvisor, { type AdvisorRequest } from "./components/MaterialsAdvisor";
import { advisorCandidates, type AdvisorAction } from "./services/AdvisorContext";

import StructurePanel from "./components/StructurePanel";
import { canViewMaterialStructure, type MaterialStructureRequest } from "./structures/materialStructure";
import { CompositionDescriptorPanel } from "./components/CompositionDescriptorPanel";
import { hashString } from "./engine/SeededRandom";
import DataHubPanel from "./components/DataHubPanel";
import { DEFAULT_HUB_QUERY, OBJECTIVES, sourceLabel, type HubMetadata, type HubQuery, type ObjectiveDirection } from "./dataHub";

const engine = new MaterialsEngine();

function initialState(budget: number, direction: ObjectiveDirection = "max"): ALState {
  return { iteration: 0, budget, sampledCount: 0, bestValue: direction === "min" ? Infinity : -Infinity, history: [] };
}

const translations = {
  en: {
    title: "AMI-AL Research Framework",
    subtitle: "Industrial-Grade Materials Active Learning System v2.0",
    reset: "Reset",
    runLoop: "Run Loop",
    stop: "Stop",
    systemConfig: "System Config",
    acquisitionStrategy: "Acquisition Strategy",
    batchSize: "Batch Size",
    budget: "Budget",
    liveMetrics: "Live Metrics",
    iteration: "Iteration",
    sampledTotal: "Sampled / Total",
    bestConductivity: "Best Observed Target",
    regretCurve: "Optimization Regret Curve",
    searchSpace: "Search Space Exploration",
    recommendations: "Recent Experimental Recommendations",
    formula: "Formula",
    status: "Status",
    predMean: "Pred. Mean",
    uncertainty: "Uncertainty",
    acquisition: "Acquisition",
    trueValue: "True Value",
    cost: "Cost",
    similarityMap: "Composition Descriptor Projection",
    methodology: "Methodology",
    representation: "Representation",
    objective: "Objective",
    sampled: "Sampled",
    candidate: "Candidate",
    pending: "Pending",
    iter: "Iter",
    methodologyDesc: "Choose an RBF Gaussian process, tree ensembles, kNN or a linear baseline. Models train on sampled labels in a background Worker. GP posterior standard deviation and ensemble disagreement have different meanings; neither guarantees convergence or accuracy on new materials.",
    representationDesc: "A shared 22-dimensional composition representation uses offline element constants: weighted means, population variances, ranges and coverage for five properties, plus a conditional ABO3 tolerance factor and validity flag. Identical compositions have identical descriptors; crystal polymorphs require additional structural data.",
    objectiveDesc: "Choose the objective and its explicit units/direction in Data Hub. Sources, methods and observation conditions remain traceable.",
    langToggle: "中文",
    docs: "Documentation",
    docsTitle: "System Documentation & Technical Specifications",
    benchmark: "Benchmark",
    benchmarkTitle: "Strategy Illustration (Not a Measured Benchmark)",
    close: "Close",
    themeClassic: "Classic",
    themeScience: "Scientific Blue",
    perfMode: "Display sampling"
  },
  zh: {
    title: "AMI-AL 科研加速框架",
    subtitle: "工业级材料主动学习优化系统 v2.0",
    reset: "重置",
    runLoop: "运行循环",
    stop: "停止",
    systemConfig: "系统配置",
    acquisitionStrategy: "获取函数策略",
    batchSize: "批次大小",
    budget: "实验预算",
    liveMetrics: "实时指标",
    iteration: "迭代轮次",
    sampledTotal: "已采样 / 总计",
    bestConductivity: "最佳已观察目标值",
    regretCurve: "优化收敛曲线 (Regret)",
    searchSpace: "搜索空间探索",
    recommendations: "近期实验推荐",
    formula: "化学式",
    status: "状态",
    predMean: "预测均值",
    uncertainty: "不确定性",
    acquisition: "获取函数值",
    trueValue: "真实值",
    cost: "实验代价",
    similarityMap: "组成描述符投影",
    methodology: "研究方法",
    representation: "特征表示",
    objective: "优化目标",
    sampled: "已采样",
    candidate: "候选",
    pending: "待定",
    iter: "轮次",
    methodologyDesc: "可选择 RBF 高斯过程、树集成、kNN 或线性基线，在后台 Worker 中使用已采样标签训练。GP 后验标准差与集成预测分歧含义不同；模型切换不保证全局收敛或对新材料的预测精度。",
    representationDesc: "所有数据源共用22维组成表示：5类元素属性的加权均值、总体方差、极差与覆盖率，加上有条件的ABO₃容忍因子和有效位。相同组成具有相同描述符；区分同质异构体仍需真实结构数据。",
    objectiveDesc: "通过Data Hub选择目标、单位与优化方向；来源、方法、条件和数据版本均保持可追溯。",
    langToggle: "English",
    docs: "系统文档",
    docsTitle: "系统文档与技术规范",
    benchmark: "性能基准",
    benchmarkTitle: "策略示意（非实测基准）",
    close: "关闭",
    themeClassic: "经典模式",
    themeScience: "科研蓝",
    perfMode: "性能模式"
  }
};

export default function App() {
  const [lang, setLang] = useState<"en" | "zh">("zh");
  const t = translations[lang];

  const [isLoaded, setIsLoaded] = useState(false);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [pool, setPool] = useState<Material[]>([]);
  const [strategy, setStrategy] = useState<AcquisitionStrategy>("UCB");
  
  // Dynamic Configs
  const [batchSize, setBatchSize] = useState(AL_CONFIG.BATCH_SIZE);
  const [totalBudget, setTotalBudget] = useState(AL_CONFIG.TOTAL_BUDGET);
  const [hubQuery, setHubQuery] = useState<HubQuery>({ ...DEFAULT_HUB_QUERY });
  const [hubMetadata, setHubMetadata] = useState<HubMetadata | null>(null);
  const objectiveSpec = OBJECTIVES[hubMetadata?.objective ?? hubQuery.objective];
  const [modelSettings, setModelSettings] = useState<ModelConfig>({ ...DEFAULT_MODEL_CONFIG });
  const [modelDiagnostics, setModelDiagnostics] = useState<ModelDiagnostics | undefined>();

  const [state, setState] = useState<ALState>(() => initialState(AL_CONFIG.TOTAL_BUDGET));
  const [isAutoRunning, setIsAutoRunning] = useState(false);
  const [isRealData, setIsRealData] = useState(false);
  const [dataIssue, setDataIssue] = useState<NetworkIssueCode | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [showAdvisor, setShowAdvisor] = useState(false);
  const [advisorRunId, setAdvisorRunId] = useState(0);
  const [advisorRequest, setAdvisorRequest] = useState<AdvisorRequest | null>(null);
  const advisorRequestId = useRef(0);
  const openAdvisor = (materialId?: string, action?: AdvisorAction) => {
    setAdvisorRequest({ requestId: ++advisorRequestId.current, materialId, action });
    setShowAdvisor(true);
  };
  const [showStructure, setShowStructure] = useState(false);
  const [hasOpenedStructure, setHasOpenedStructure] = useState(false);
  const [structureMaterial, setStructureMaterial] = useState<MaterialStructureRequest | null>(null);
  const structureRequestId = useRef(0);
  const openStructure = () => { setStructureMaterial(null); setHasOpenedStructure(true); setShowStructure(true); };
  const openMaterialStructure = (material: Material) => {
    setStructureMaterial({ id: material.id, formula: material.formula, source: material.source, structureRef: material.structureRef, requestId: ++structureRequestId.current });
    setHasOpenedStructure(true); setShowStructure(true);
  };
  const [theme, setTheme] = useState<'classic' | 'science'>('classic');
  const [isIterating, setIsIterating] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const loadRequest = useRef(0);
  const runVersion = useRef(0);
  const iterationInFlight = useRef(false);
  const modelClient = useRef<ModelWorkerClient | null>(null);
  const activeRun = useRef<AbortController | null>(null);
  const stopReason = getStopReason(pool, totalBudget);

  const cancelComputation = () => {
    runVersion.current++;
    activeRun.current?.abort();
    modelClient.current?.cancel();
    iterationInFlight.current = false;
    setIsIterating(false);
  };

  const loadData = async (query: HubQuery) => {
    setHubQuery(query);
    setAdvisorRunId(value => value + 1);
    const request = ++loadRequest.current;
    cancelComputation();
    setModelDiagnostics(undefined);
    setIsAutoRunning(false);
    setRunError(null);
    setDataIssue(null);
    setIsLoadingData(true);
    try {
      const metadata = await engine.loadHubData(query);
      if (request !== loadRequest.current) return;
      if (!metadata) return;
      setPool(engine.getPool());
      setHubMetadata(metadata);
      setIsRealData(true);
      setDataIssue(engine.getLoadIssue());
      setState(initialState(totalBudget, OBJECTIVES[metadata.objective].direction));
      setIsLoaded(true);
    } catch (error) {
      if (request !== loadRequest.current) return;
      setPool([]);
      setHubMetadata(null);
      setState(initialState(totalBudget, OBJECTIVES[query.objective].direction));
      setIsRealData(false);
      setDataIssue("NETWORK_ERROR");
      setRunError(error instanceof Error ? error.message : "Data Hub load failed.");
      setIsLoaded(true);
    } finally {
      if (request === loadRequest.current) setIsLoadingData(false);
    }
  };

  useEffect(() => {
    void loadData(hubQuery);
    return () => {
      loadRequest.current++;
      runVersion.current++;
      activeRun.current?.abort();
      modelClient.current?.dispose();
      iterationInFlight.current = false;
      engine.cancelLoad();
    };
  }, []);

  // Performance-optimized chart data (downsampling for large datasets)
  const chartData = useMemo(() => {
    const available = pool.filter(m => Number.isFinite(m.descriptors?.statistics.electronegativityPauling.mean)
      && Number.isFinite(m.descriptors?.statistics.covalentRadiusAngstrom.mean));
    if (available.length <= 2000) return available;
    const sampled = available.filter(m => m.isSampled);
    const unsampled = available.filter(m => !m.isSampled).sort((a, b) => hashString(a.id) - hashString(b.id));
    return [...sampled, ...unsampled.slice(0, Math.max(0, 2000 - sampled.length))];
  }, [pool]);

  const runIteration = async () => {
    if (iterationInFlight.current || isLoadingData) return;
    const version = runVersion.current;
    iterationInFlight.current = true;
    setIsIterating(true);
    const controller = new AbortController();
    activeRun.current = controller;
    try {
      if (!modelClient.current) modelClient.current = new ModelWorkerClient(modelSettings);
      const result = await runActiveLearningStep(pool, state, {
        totalBudget, batchSize, strategy, direction: objectiveSpec.direction, signal: controller.signal, random: seededRandom(modelSettings.seed),
      }, modelClient.current);
      if (version !== runVersion.current) return;
      setPool(result.pool);
      setState(result.state);
      setModelDiagnostics(modelClient.current.diagnostics);
      if (result.stopReason) setIsAutoRunning(false);
    } catch (error) {
      if (version !== runVersion.current) return;
      setRunError((lang === "zh" ? "模型迭代失败，请重置后重试：" : "Model iteration failed. Reset and retry: ")
        + (error instanceof Error ? error.message : "Unknown error"));
      setIsAutoRunning(false);
    } finally {
      if (version === runVersion.current) {
        iterationInFlight.current = false;
        setIsIterating(false);
        activeRun.current = null;
      }
    }
  };

  const reset = () => {
    setAdvisorRunId(value => value + 1);
    cancelComputation();
    setModelDiagnostics(undefined);
    setRunError(null);
    // In-place reset of the current pool to avoid re-loading from API
    const resetPool = pool.map(m => ({
      ...m,
      isSampled: false,
      iteration: undefined,
      predictedMean: undefined,
      predictedStd: undefined,
      acquisitionValue: undefined
    }));
    
    setPool(resetPool);
    setState(initialState(totalBudget, objectiveSpec.direction));
    setIsAutoRunning(false);
  };

  useEffect(() => {
    if (!isAutoRunning || isLoadingData || isIterating) return;
    if (stopReason || runError) {
      setIsAutoRunning(false);
      return;
    }
    const timer = setTimeout(() => { void runIteration(); }, 800);
    return () => clearTimeout(timer);
  }, [isAutoRunning, isLoadingData, isIterating, pool, state, strategy, batchSize, totalBudget, stopReason, runError]);

  const topAdvisorCandidates = useMemo(() => advisorCandidates(pool), [pool]);

  if (!isLoaded) {
    return (
      <div className="min-h-screen bg-[#F5F5F0] flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-[#141414] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm font-bold uppercase tracking-widest opacity-60">正在加载 Data Hub 数据目录…</p>
          <button type="button" onClick={openStructure} className="px-4 py-2 border rounded-lg">
            {lang === "zh" ? "先导入结构 / 3D 查看" : "Import structure / 3D viewer"}
          </button>
        </div>
        {hasOpenedStructure && <React.Fragment key="structure-workspace"><StructurePanel open={showStructure} onClose={() => setShowStructure(false)} lang={lang} materialRequest={structureMaterial} onImportMode={openStructure} /></React.Fragment>}
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${theme === 'classic' ? 'bg-[#F5F5F0] text-[#141414]' : 'bg-[#F0F4F8] text-[#1A365D]'} font-sans transition-colors duration-500 p-6`}>
      {/* Header */}
      <header className={`max-w-7xl mx-auto mb-8 flex flex-wrap gap-5 justify-between items-end border-b ${theme === 'classic' ? 'border-[#141414]/10' : 'border-[#2B6CB0]/20'} pb-4`}>
        <div>
          <h1 className="text-4xl font-serif italic font-medium tracking-tight">
            {t.title}
          </h1>
          <p className="text-sm opacity-60 uppercase tracking-widest mt-2">
            {t.subtitle}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => openAdvisor()} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[#b5a36d] bg-[#f3ecd7] text-[#514522] text-xs font-bold">
            <Sparkles size={14} /> {lang === "zh" ? "AI 首席材料顾问" : "AI Materials Advisor"}
          </button>
          <button type="button" onClick={openStructure} className="flex items-center gap-2 px-4 py-2 rounded-lg border border-teal-700 bg-teal-700 text-white text-xs font-bold">
            <Layers size={14} /> {lang === "zh" ? "结构导入 / 3D" : "Structure / 3D"}
          </button>
          <button 
            onClick={() => setTheme(theme === 'classic' ? 'science' : 'classic')}
            className={`flex items-center gap-2 px-4 py-2 border ${theme === 'classic' ? 'border-[#141414]/20 hover:bg-[#141414]/5' : 'border-[#2B6CB0]/30 hover:bg-[#2B6CB0]/5 text-[#2B6CB0]'} transition-colors text-xs uppercase font-bold tracking-tighter rounded-lg`}
          >
            <Palette size={14} /> {theme === 'classic' ? t.themeScience : t.themeClassic}
          </button>
          <button 
            onClick={() => setShowBenchmark(true)}
            className={`flex items-center gap-2 px-4 py-2 border ${theme === 'classic' ? 'border-[#141414]/20 hover:bg-[#141414]/5' : 'border-[#2B6CB0]/30 hover:bg-[#2B6CB0]/5 text-[#2B6CB0]'} transition-colors text-xs uppercase font-bold tracking-tighter rounded-lg`}
          >
            <BarChart3 size={14} /> {t.benchmark}
          </button>
          <button 
            onClick={() => setShowDocs(true)}
            className={`flex items-center gap-2 px-4 py-2 border ${theme === 'classic' ? 'border-[#141414]/20 hover:bg-[#141414]/5' : 'border-[#2B6CB0]/30 hover:bg-[#2B6CB0]/5 text-[#2B6CB0]'} transition-colors text-xs uppercase font-bold tracking-tighter rounded-lg`}
          >
            <FileText size={14} /> {t.docs}
          </button>
          <button 
            onClick={() => setLang(lang === "en" ? "zh" : "en")}
            className={`flex items-center gap-2 px-4 py-2 border ${theme === 'classic' ? 'border-[#141414]/20 hover:bg-[#141414]/5' : 'border-[#2B6CB0]/30 hover:bg-[#2B6CB0]/5 text-[#2B6CB0]'} transition-colors text-xs uppercase font-bold tracking-tighter rounded-lg`}
          >
            {t.langToggle}
          </button>
          <button 
            onClick={reset}
            disabled={isLoadingData || isIterating}
            className={`flex items-center gap-2 px-4 py-2 border ${theme === 'classic' ? 'border-[#141414] hover:bg-[#141414] hover:text-[#F5F5F0]' : 'border-[#2B6CB0] text-[#2B6CB0] hover:bg-[#2B6CB0] hover:text-white'} transition-colors text-xs uppercase font-bold tracking-tighter`}
          >
            <RotateCcw size={14} /> {t.reset}
          </button>
          <button 
            onClick={() => {
              if (isAutoRunning) cancelComputation();
              setIsAutoRunning(!isAutoRunning);
            }}
            disabled={!isAutoRunning && (isLoadingData || isIterating || stopReason !== null || runError !== null)}
            className={`flex items-center gap-2 px-6 py-2 ${isAutoRunning ? 'bg-red-500 text-white border-red-500' : (theme === 'classic' ? 'bg-[#141414] text-[#F5F5F0]' : 'bg-[#2B6CB0] text-white')} border border-transparent transition-colors text-xs uppercase font-bold tracking-tighter disabled:opacity-30`}
          >
            {isAutoRunning ? <><AlertCircle size={14} /> {t.stop}</> : <><Play size={14} /> {t.runLoop}</>}
          </button>
        </div>
      </header>

      {!isLoadingData && (runError || stopReason) && (
        <p role={runError ? "alert" : "status"} className="max-w-7xl mx-auto mb-6 p-3 rounded-lg bg-amber-50 text-amber-900">
          {runError || (stopReason === "empty-pool"
            ? (lang === "zh" ? "没有候选材料，请同步数据后再运行。" : "No candidate materials. Sync data before running.")
            : stopReason === "budget-exhausted"
              ? (lang === "zh" ? "已达到采样预算。" : "Sampling budget reached.")
              : (lang === "zh" ? "候选材料已全部采样。" : "All candidate materials have been sampled."))}
        </p>
      )}

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar: Config & Stats */}
        <div className="lg:col-span-3 min-w-0 space-y-6">
          <DataHubPanel query={hubQuery} metadata={hubMetadata} count={pool.length} loading={isLoadingData}
            lang={lang} onChange={setHubQuery} onLoad={query => void loadData(query)} />

          <section className={`${theme === 'classic' ? 'bg-white' : 'bg-white/80'} p-6 rounded-3xl shadow-sm border ${theme === 'classic' ? 'border-[#141414]/5' : 'border-[#2B6CB0]/10'}`}>
            <h3 className={`text-xs font-bold uppercase tracking-widest opacity-40 mb-4 flex items-center gap-2 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>
              <Layers size={14} /> {t.systemConfig}
            </h3>
            <div className="space-y-4">
              <div>
                <label className="text-[10px] uppercase font-bold opacity-60">{t.acquisitionStrategy}</label>
                <select 
                  value={strategy}
                  onChange={(e) => setStrategy(e.target.value as AcquisitionStrategy)}
                  disabled={isLoadingData || isAutoRunning || isIterating || state.iteration > 0}
                  title={lang === "zh" ? "运行后需先重置再切换策略，以保持分数与策略一致。" : "Reset before changing strategy after a run so stored scores match the strategy."}
                  className={`w-full mt-1 ${theme === 'classic' ? 'bg-[#F5F5F0]' : 'bg-blue-50'} border-none rounded-lg p-2 text-sm font-medium focus:ring-1 ${theme === 'classic' ? 'focus:ring-[#141414]' : 'focus:ring-[#2B6CB0]'}`}
                >
                  <option value="UCB">{lang === 'en' ? 'Upper Confidence Bound (UCB)' : '上置信界 (UCB)'}</option>
                  <option value="EI">{lang === 'en' ? 'Expected Improvement (EI)' : '期望改进 (EI)'}</option>
                  <option value="Uncertainty">{lang === 'en' ? 'Uncertainty Sampling' : '不确定性采样'}</option>
                  <option value="Random">{lang === 'en' ? 'Random (Baseline)' : '随机采样 (基准)'}</option>
                </select>
              </div>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <div className="flex justify-between">
                    <label className="text-[10px] uppercase font-bold opacity-60">{t.batchSize}</label>
                    <span className="text-[10px] font-mono font-bold">{batchSize}</span>
                  </div>
                  <input 
                    type="range" min="1" max="20" step="1"
                    value={batchSize}
                    onChange={(e) => setBatchSize(parseInt(e.target.value))}
                    disabled={state.iteration > 0 || isLoadingData || isIterating}
                    className={`w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer ${theme === 'classic' ? 'accent-[#141414]' : 'accent-[#2B6CB0]'} mt-2`}
                  />
                </div>
                <div>
                  <div className="flex justify-between">
                    <label className="text-[10px] uppercase font-bold opacity-60">{t.budget}</label>
                    <span className="text-[10px] font-mono font-bold">{totalBudget}</span>
                  </div>
                  <input 
                    type="range" min="10" max="200" step="10"
                    value={totalBudget}
                    onChange={(e) => setTotalBudget(parseInt(e.target.value))}
                    disabled={state.iteration > 0 || isLoadingData || isIterating}
                    className={`w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer ${theme === 'classic' ? 'accent-[#141414]' : 'accent-[#2B6CB0]'} mt-2`}
                  />
                </div>
              </div>
            </div>
          </section>

          <ModelControls config={modelSettings} lang={lang} busy={isIterating} diagnostics={modelDiagnostics}
            locked={isLoadingData || isAutoRunning || isIterating || state.iteration > 0}
            onChange={config => {
              cancelComputation();
              modelClient.current?.dispose();
              modelClient.current = null;
              setModelSettings(config);
              setModelDiagnostics(undefined);
            }} />

          <section className={`${theme === 'classic' ? 'bg-[#141414] text-[#F5F5F0]' : 'bg-[#1A365D] text-white'} p-6 rounded-3xl shadow-xl`}>
            <h3 className="text-xs font-bold uppercase tracking-widest opacity-40 mb-4 flex items-center gap-2">
              <TrendingUp size={14} /> {t.liveMetrics}
            </h3>
            <div className="space-y-6">
              <div>
                <p className="text-[10px] uppercase font-bold opacity-40">{t.iteration}</p>
                <p className="text-4xl font-serif italic">{state.iteration}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold opacity-40">{t.sampledTotal}</p>
                <div className="flex items-end gap-2">
                  <p className="text-3xl font-serif italic">{state.sampledCount}</p>
                  <p className="text-sm opacity-40 mb-1">/ {totalBudget}</p>
                </div>
                <div className="w-full bg-white/10 h-1 mt-2 rounded-full overflow-hidden">
                  <motion.div 
                    className={theme === 'classic' ? "bg-emerald-400 h-full" : "bg-teal-400 h-full"}
                    initial={{ width: 0 }}
                    animate={{ width: `${(state.sampledCount / totalBudget) * 100}%` }}
                  />
                </div>
              </div>
              <div>
                <p className="text-[10px] uppercase font-bold opacity-40">{t.bestConductivity}</p>
                <p className={`text-3xl font-serif italic ${theme === 'classic' ? 'text-emerald-400' : 'text-teal-300'}`}>
                  {!Number.isFinite(state.bestValue) ? "N/A" : state.bestValue.toFixed(4)}
                </p>
                <p className="mt-2 text-xs opacity-60">{objectiveSpec[lang]} / {objectiveSpec.unit} · {objectiveSpec.direction === "min" ? "↓ min" : "↑ max"}</p>
              </div>
            </div>
          </section>
        </div>

        {/* Main Content: Visualization */}
        <div className="lg:col-span-9 min-w-0 space-y-8">
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-teal-100 bg-teal-50 p-4"><div><p className="text-[10px] font-bold tracking-widest text-teal-700">{sourceLabel(hubMetadata?.effectiveSource ?? hubQuery.source, lang)} · {pool.length} {lang === "zh" ? "条记录" : "records"}</p><h2 className="mt-1 text-lg font-semibold text-teal-950">{objectiveSpec[lang]} <span className="text-sm font-normal">/ {objectiveSpec.unit}</span></h2></div><span className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-teal-800">{objectiveSpec.direction === "min" ? "↓ Minimize" : "↑ Maximize"}</span></section>
          {/* Charts Row */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
            <div className={`${theme === 'classic' ? 'bg-white' : 'bg-white/80'} p-6 rounded-3xl border ${theme === 'classic' ? 'border-[#141414]/5' : 'border-[#2B6CB0]/10'} h-[350px]`}>
              <h3 className={`text-xs font-bold uppercase tracking-widest opacity-40 mb-4 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>{t.regretCurve}</h3>
              <ResponsiveContainer width="100%" height="90%">
                <LineChart data={state.history}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme === 'classic' ? "#14141410" : "#2B6CB010"} />
                  <XAxis dataKey="iteration" hide />
                  <YAxis strokeOpacity={0.4} fontSize={10} tickFormatter={(val) => val.toFixed(2)} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                  />
                  <Line 
                    type="monotone" 
                    dataKey="regret" 
                    stroke={theme === 'classic' ? "#141414" : "#2B6CB0"} 
                    strokeWidth={3} 
                    dot={{ r: 4, fill: theme === 'classic' ? "#141414" : "#2B6CB0" }} 
                    activeDot={{ r: 6 }}
                    animationDuration={300}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className={`${theme === 'classic' ? 'bg-white' : 'bg-white/80'} p-6 rounded-3xl border ${theme === 'classic' ? 'border-[#141414]/5' : 'border-[#2B6CB0]/10'} h-[350px]`}>
              <h3 className={`text-xs font-bold uppercase tracking-widest opacity-40 mb-4 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>{t.similarityMap}</h3>
              <ResponsiveContainer width="100%" height="90%">
                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme === 'classic' ? "#14141410" : "#2B6CB010"} />
                  <XAxis type="number" dataKey="descriptors.statistics.electronegativityPauling.mean" name="χ mean" tick={{ fontSize: 10 }} />
                  <YAxis type="number" dataKey="descriptors.statistics.covalentRadiusAngstrom.mean" name="Covalent radius mean" unit=" Å" tick={{ fontSize: 10 }} />
                  <Tooltip 
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload as Material;
                        return (
                          <div className={`${theme === 'classic' ? 'bg-[#141414] text-white' : 'bg-[#1A365D] text-white'} p-4 rounded-2xl shadow-2xl border-none text-[10px] space-y-1 backdrop-blur-md bg-opacity-90`}>
                            <p className="font-bold uppercase tracking-widest opacity-50 mb-2">{data.formula}</p>
                            <p>Cost: <span className="font-mono text-blue-300">{data.cost.toFixed(2)} units</span></p>
                            <p>{objectiveSpec[lang]}: <span className="font-mono text-emerald-400">{data.isSampled ? `${data.trueProperty.toFixed(3)} ${objectiveSpec.unit}` : (lang === "zh" ? "未观测" : "Unobserved")}</span></p>
                            <p className="pt-1 opacity-50 italic">χ mean / covalent-radius mean (Å)</p>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Scatter 
                    name="Unsampled" 
                    data={chartData.filter(m => !m.isSampled)} 
                    fill={theme === 'classic' ? "#141414" : "#2B6CB0"} 
                    fillOpacity={0.05} 
                  />
                  <Scatter 
                    name="Sampled" 
                    data={chartData.filter(m => m.isSampled)} 
                    fill={theme === 'classic' ? "#10B981" : "#38B2AC"} 
                  >
                    {chartData.filter(m => m.isSampled).map((entry, index) => (
                      <Cell 
                        key={`cell-${index}`} 
                        fill={entry.trueProperty === state.bestValue ? (theme === 'classic' ? "#F59E0B" : "#F6AD55") : (theme === 'classic' ? "#10B981" : "#38B2AC")} 
                        stroke="#fff" 
                        strokeWidth={2}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>

          <section className="rounded-3xl border border-[#d6dfce] bg-[#f5f6ec] p-5" aria-label={lang === "zh" ? "AI 优先候选" : "AI candidate shortlist"}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div><h3 className="flex items-center gap-2 text-sm font-semibold text-[#35523c]"><Sparkles size={16} />{lang === "zh" ? "让推荐走向研究方案" : "From ranking to a research plan"}</h3><p className="text-[10px] text-[#7b8971] mt-1">{lang === "zh" ? `第 ${state.iteration} 轮 · 最近一次预测的 Top-3 · 下一轮重训可能改变排序` : `Round ${state.iteration} · Top 3 from the last prediction pass · Retraining may change the order`}</p></div>
              <button type="button" disabled={isLoadingData || isIterating} onClick={() => openAdvisor(undefined, "overview")} className="text-xs font-semibold text-[#456447] px-3 py-2 rounded-lg border border-[#c4d1bb] bg-white disabled:opacity-40">{lang === "zh" ? "AI 复盘本轮" : "Review this round"}</button>
            </div>
            {topAdvisorCandidates.length ? <div className="grid grid-cols-1 md:grid-cols-3 gap-3">{topAdvisorCandidates.map((m, index) => <div key={m.id} className="bg-white/85 rounded-xl border border-[#e0e5d7] p-4">
              <div className="flex justify-between items-start gap-2"><span className="font-serif text-lg italic">{m.formula}</span><span className="text-[10px] text-[#9a8a50]">0{index + 1}</span></div>
              <p className="text-[9px] text-[#8d9782] font-mono truncate mt-1">{m.id}</p>
              <div className="text-[10px] flex flex-wrap gap-x-3 gap-y-1 text-[#5e7157] font-mono my-3"><span>µ {m.predictedMean?.toFixed(3)}</span><span>σ {m.predictedStd?.toFixed(3)}</span><span>{lang === "zh" ? "成本" : "Cost"} {m.cost.toFixed(2)}</span></div>
              <div className="flex flex-wrap gap-2"><button type="button" disabled={isLoadingData || isIterating} onClick={() => openAdvisor(m.id, "mechanism")} className="text-[10px] text-[#7a6230] px-2 py-1.5 rounded-md bg-[#f5efdc] disabled:opacity-40">✨ {lang === "zh" ? "AI 机理解析" : "Explain selection"}</button><button type="button" disabled={isLoadingData || isIterating} onClick={() => openAdvisor(m.id, "dft")} className="text-[10px] text-[#41644b] px-2 py-1.5 rounded-md bg-[#ecf2e7] disabled:opacity-40">{lang === "zh" ? "DFT 方案" : "DFT plan"}</button></div>
            </div>)}</div> : <p className="text-xs leading-relaxed text-[#829077]">{lang === "zh" ? "运行一轮主动学习后，这里会展示可解析的候选。也可以打开顾问，先讨论当前材料与研究目标。" : "Run a learning step to populate this shortlist, or open the advisor to discuss your materials and research objective."}</p>}
          </section>

          {/* Data Table / Material List */}
          <div className={`${theme === 'classic' ? 'bg-white' : 'bg-white/90'} rounded-3xl border ${theme === 'classic' ? 'border-[#141414]/5' : 'border-[#2B6CB0]/10'} overflow-hidden`}>
            <div className={`p-6 border-b ${theme === 'classic' ? 'border-[#141414]/5' : 'border-[#2B6CB0]/10'} flex justify-between items-center`}>
              <h3 className={`text-xs font-bold uppercase tracking-widest opacity-40 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>{t.recommendations}</h3>
              <div className="flex gap-2">
                <span className={`flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 ${theme === 'classic' ? 'bg-emerald-100 text-emerald-700' : 'bg-teal-100 text-teal-700'} rounded-full`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${theme === 'classic' ? 'bg-emerald-500' : 'bg-teal-500'} animate-pulse`} /> {t.sampled}
                </span>
                <span className="flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-1 bg-gray-100 text-gray-500 rounded-full">
                  {t.candidate}
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className={theme === 'classic' ? "bg-[#F5F5F0]/50" : "bg-blue-50/50"}>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">ID</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{t.formula}</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{t.cost}</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{t.predMean}</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{t.uncertainty}</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{t.acquisition}</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{t.trueValue}</th>
                    <th className="p-4 text-[10px] uppercase font-bold opacity-40">{lang === "zh" ? "AI 顾问" : "AI Advisor"}</th>
                  </tr>
                </thead>
                <tbody>
                  <AnimatePresence mode="popLayout">
                    {pool
                      .filter(m => m.isSampled || Number.isFinite(m.acquisitionValue))
                      .sort((a, b) => {
                        if (a.isSampled && !b.isSampled) return -1;
                        if (!a.isSampled && b.isSampled) return 1;
                        return (b.acquisitionValue || 0) - (a.acquisitionValue || 0);
                      })
                      .slice(0, 8)
                      .map((m) => (
                        <motion.tr 
                          layout
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          key={m.id} 
                          onClick={() => openMaterialStructure(m)}
                          className={`cursor-pointer border-b border-[#141414]/5 hover:bg-[#F5F5F0]/30 transition-colors ${m.isSampled ? (theme === 'classic' ? 'bg-emerald-50/30' : 'bg-teal-50/30') : ''}`}
                        >
                          <td className="p-4 font-mono text-[10px] opacity-40">{m.id}</td>
                          <td className="p-4 font-serif italic text-lg">
                            <button type="button" onClick={event => { event.stopPropagation(); openMaterialStructure(m); }}
                              className="text-left hover:underline focus-visible:outline-2 focus-visible:outline-teal-600"
                              aria-label={lang === "zh" ? `查看 ${m.formula}（${m.id}）的结构` : `View structure of ${m.formula} (${m.id})`}>
                              {m.formula}<span className="ml-2 text-[10px] font-sans not-italic text-teal-700">{canViewMaterialStructure(m) ? (lang === "zh" ? "查看 3D" : "View 3D") : (lang === "zh" ? "暂无结构" : "No structure")}</span>
                            </button>
                            <p className="mt-1 text-[9px] font-sans not-italic text-slate-500" title={m.methodMeta}>{sourceLabel(m.source, lang)} · {m.fidelity ?? "—"}</p>
                            {m.provenance && <a href={m.provenance.url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-[9px] font-sans not-italic text-teal-700 underline" title={`${m.provenance.reference} · ${m.provenance.datasetVersion}`}>{lang === "zh" ? "来源 / 方法" : "Provenance"}</a>}
                            {m.isSampled && (
                              <span className={`ml-2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${theme === 'classic' ? 'bg-emerald-100 text-emerald-700' : 'bg-teal-100 text-teal-700'}`}>
                                Iter {m.iteration}
                              </span>
                            )}
                          </td>
                          <td className="p-4 font-mono text-xs text-blue-500 font-bold">{m.cost.toFixed(2)}</td>
                          <td className="p-4 font-mono text-xs">{m.predictedMean?.toFixed(3) || "—"}</td>
                          <td className="p-4 font-mono text-xs">{m.predictedStd?.toFixed(3) || "—"}</td>
                          <td className="p-4">
                            <div className="flex items-center gap-2">
                              <div className={`w-12 ${theme === 'classic' ? 'bg-gray-100' : 'bg-blue-100'} h-1.5 rounded-full overflow-hidden`}>
                                <div 
                                  className={`${theme === 'classic' ? 'bg-[#141414]' : 'bg-[#2B6CB0]'} h-full`} 
                                  style={{ width: `${Number.isFinite(m.acquisitionValue) ? 100 / (1 + Math.exp(-Math.max(-30, Math.min(30, m.acquisitionValue!)))) : 0}%` }}
                                />
                              </div>
                              <span className="font-mono text-[10px]">{m.acquisitionValue?.toFixed(2) || "0.00"}</span>
                            </div>
                          </td>
                          <td className="p-4 font-mono text-xs font-bold">
                            {m.isSampled ? `${m.trueProperty.toFixed(4)} ${objectiveSpec.unit}` : "???"}
                          </td>
                          <td className="p-3 text-[10px] min-w-28"><button type="button" disabled={isLoadingData || isIterating} onClick={event => { event.stopPropagation(); openAdvisor(m.id, "mechanism"); }} className="block text-[#8b6d29] hover:underline disabled:opacity-40">✨ {lang === "zh" ? "AI 机理解析" : "Explain selection"}</button><button type="button" disabled={isLoadingData || isIterating} onClick={event => { event.stopPropagation(); openAdvisor(m.id); }} className="block mt-2 text-[#51774e] hover:underline disabled:opacity-40">{lang === "zh" ? "合成 / 计算方案" : "Research plan"}</button></td>
                        </motion.tr>
                      ))}
                  </AnimatePresence>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>

      <button type="button" onClick={() => openAdvisor()} className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-5 py-3 rounded-full bg-[#1e5542] text-[#f8f4df] border border-[#b9ac73] shadow-xl text-xs font-semibold" aria-label={lang === "zh" ? "打开 AI 首席材料顾问" : "Open AI materials advisor"}><Sparkles size={17} />{lang === "zh" ? "问问材料顾问" : "Ask the advisor"}</button>
      <MaterialsAdvisor open={showAdvisor} onClose={() => setShowAdvisor(false)} input={{ pool, state, strategy, batchSize, totalBudget, isRealData, runId: advisorRunId, modelConfig: modelSettings, hubMetadata, hubQuery: hubMetadata?.query ?? hubQuery, hubLoadState: isLoadingData ? "loading" : runError && !hubMetadata ? "error" : "ready" }} lang={lang} loading={isLoadingData || isIterating} request={advisorRequest} />
      <CompositionDescriptorPanel key={`${isRealData}:${pool[0]?.id ?? "empty"}`} materials={pool} lang={lang} />

      {/* Research Methodology Modal / Info */}
      <footer className={`max-w-7xl mx-auto mt-12 grid grid-cols-1 md:grid-cols-3 gap-8 border-t ${theme === 'classic' ? 'border-[#141414]/10' : 'border-[#2B6CB0]/20'} pt-8 pb-12`}>
        <div className="space-y-2">
          <h4 className={`text-xs font-bold uppercase tracking-widest flex items-center gap-2 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>
            <Beaker size={14} /> {t.methodology}
          </h4>
          <p className="text-xs opacity-60 leading-relaxed">
            {t.methodologyDesc}
          </p>
        </div>
        <div className="space-y-2">
          <h4 className={`text-xs font-bold uppercase tracking-widest flex items-center gap-2 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>
            <Cpu size={14} /> {t.representation}
          </h4>
          <p className="text-xs opacity-60 leading-relaxed">
            {t.representationDesc}
          </p>
        </div>
        <div className="space-y-2">
          <h4 className={`text-xs font-bold uppercase tracking-widest flex items-center gap-2 ${theme === 'science' ? 'text-[#2B6CB0]' : ''}`}>
            <Zap size={14} /> {t.objective}
          </h4>
          <p className="text-xs opacity-60 leading-relaxed">
            {objectiveSpec[lang]} / {objectiveSpec.unit} · {objectiveSpec.direction === "min" ? (lang === "zh" ? "最小化" : "Minimize") : (lang === "zh" ? "最大化" : "Maximize")}。{lang === "zh" ? "目标值按来源、方法与条件保留；本轮采用已有观测的离线回放。" : "Targets retain source, method and conditions; this run replays existing observations."}
          </p>
        </div>
      </footer>

      {/* Documentation Modal */}
      <AnimatePresence>
        {showDocs && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#141414]/40 backdrop-blur-sm p-6"
            onClick={() => setShowDocs(false)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-white w-full max-w-4xl max-h-[85vh] rounded-[32px] shadow-2xl overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-8 border-b border-gray-100 flex justify-between items-center">
                <div>
                  <h2 className="text-2xl font-serif italic font-medium">{t.docsTitle}</h2>
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mt-1">Version 2.0.0 • Materials Active Learning Framework</p>
                </div>
                <button 
                  onClick={() => setShowDocs(false)}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-8 space-y-10">
                {lang === 'en' ? (
                  <>
                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">01. System Overview</h3>
                      <p className="text-sm leading-relaxed opacity-70">
                        The AMI-AL (Accelerated Materials Innovation - Active Learning) framework is an industrial-grade closed-loop optimization system. It accelerates the discovery of high-performance materials (e.g., solid-state electrolytes, high-voltage insulators) by integrating real-world data from the Materials Project with advanced Bayesian Optimization. The system is designed to minimize expensive DFT "experiments" while maximizing computational cost-effectiveness.
                      </p>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">02. Mathematical Logic & BO Loop</h3>
                      <div className="bg-gray-50 p-6 rounded-2xl border border-gray-100 space-y-4">
                        <p className="text-xs font-mono opacity-80">
                          Objective: {objectiveSpec.direction === "min" ? "argmin" : "argmax"} f(x), {objectiveSpec.en} / {objectiveSpec.unit}.
                        </p>
                        <p className="text-xs leading-relaxed opacity-70">
                          The system follows a rigorous 4-step cycle:
                          <br/>1. <strong>Surrogate Modeling:</strong> Choose a GP posterior or ensemble-based regressor to estimate μ(x) and σ(x).
                          <br/>2. <strong>Acquisition Optimization:</strong> x* = argmax α(x; P), where α is UCB, EI, or Cost-Aware variants.
                          <br/>3. <strong>Oracle Evaluation:</strong> Query f(x*) via DFT (simulated via ground truth data).
                          <br/>4. <strong>Data Augmentation:</strong> D = D ∪ {"{x*, f(x*)}"}, updating the knowledge base.
                        </p>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">03. Technical Architecture</h3>
                      <div className="grid grid-cols-2 gap-8">
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">Surrogate Model</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            Select RBF GPR (default), Random Forest, Extra Trees, Gradient Boosted Trees, kNN, Ridge, or the linear SGD baseline. Training-only feature/target standardization and seeded fitting run in a Worker. GP σ is a latent posterior standard deviation; other models expose ensemble disagreement. These quantities require validation on held-out materials.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">Cost-Aware Acquisition</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            The system implements <strong>cost-aware acquisition</strong>. Scores are divided by a heuristic formula-size cost based on atom counts. This proxy does not measure DFT hours or structural complexity.
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">04. Feature Engineering & Polymorphs</h3>
                      <div className="grid grid-cols-2 gap-8">
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">Descriptor Vector</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            The offline JSON table provides Pauling electronegativity, covalent and reference ionic radii, a declared valence-electron convention and atomic hardness. Weighted mean/variance/range/coverage for each property plus conditional ABO3 t/validity yield 22 scaled model inputs. Raw physical units remain visible in the descriptor panel.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">Polymorph Differentiation</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            Composition alone cannot distinguish polymorphs. Equal compositions share identical descriptors. Actual lattice, coordination or distortion information must be supplied separately rather than generated from a random number.
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">05. Benchmarking & AMI Alignment</h3>
                      <p className="text-sm leading-relaxed opacity-70">
                        The discovery chart is a scripted illustration and does not compare the fitted models. The model benchmark script and browser Worker validation page measure synthetic fit/predict times and held-out error. Real-material accuracy, uncertainty calibration and discovery speedup require separate controlled experiments.
                      </p>
                    </section>
                  </>
                ) : (
                  <>
                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">01. 系统概述</h3>
                      <p className="text-sm leading-relaxed opacity-70">
                        AMI-AL（加速材料创新 - 主动学习）框架是一个工业级的闭环优化系统。它通过将 Materials Project 的真实数据与先进的贝叶斯优化相结合，加速高性能材料（如固态电解质、高压绝缘体）的发现。该系统旨在最小化昂贵的 DFT “实验”次数，同时最大化计算性价比。
                      </p>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">02. 数学逻辑与 BO 闭环</h3>
                      <div className="bg-gray-50 p-6 rounded-2xl border border-gray-100 space-y-4">
                        <p className="text-xs font-mono opacity-80">
                          目标函数: {objectiveSpec.direction === "min" ? "argmin" : "argmax"} f(x)，{objectiveSpec.zh} / {objectiveSpec.unit}。
                        </p>
                        <p className="text-xs leading-relaxed opacity-70">
                          系统遵循严密的 4 步循环逻辑：
                          <br/>1. <strong>代理建模:</strong> 选择 GP 后验或集成回归模型，估计 μ(x) 和 σ(x)。
                          <br/>2. <strong>获取函数优化:</strong> x* = argmax α(x; P)，其中 α 为 UCB、EI 或代价敏感变体。
                          <br/>3. <strong>实验评估:</strong> 通过 DFT（由真实数据模拟）查询 f(x*)。
                          <br/>4. <strong>数据增强:</strong> D = D ∪ {"{x*, f(x*)}"}，更新知识库并重新训练。
                        </p>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">03. 技术架构</h3>
                      <div className="grid grid-cols-2 gap-8">
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">代理模型 (Surrogate Model)</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            支持 RBF GPR（默认）、随机森林、Extra Trees、梯度提升树、kNN、岭回归和线性 SGD 基线。特征与目标只按训练样本标准化，在 Worker 中按固定种子拟合。GP σ 为潜在函数后验标准差，其它模型输出集成分歧；需要独立留出材料验证，不能直接视为已校准置信区间。
                          </p>
                        </div>
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">代价敏感优化 (Cost-Aware BO)</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            系统实现了<strong>代价感知获取函数</strong>。分数按化学式原子计数的启发式成本归一化；该估计不代表实测 DFT 耗时或真实结构复杂度。
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">04. 特征工程与同质异构体</h3>
                      <div className="grid grid-cols-2 gap-8">
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">描述符向量</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            内置JSON提供鲍林电负性、共价/参考离子半径、约定价电子数和原子化学硬度。每类属性的加权均值、总体方差、极差和覆盖率，加上有条件ABO₃容忍因子及有效位，共22维缩放模型输入；面板保留原始物理单位。
                          </p>
                        </div>
                        <div className="space-y-2">
                          <h4 className="text-xs font-bold uppercase">同质异构体区分</h4>
                          <p className="text-xs opacity-60 leading-relaxed">
                            仅凭组成不能区分同质异构体，相同组成必须得到相同描述符。真实晶格、近邻配位和畸变信息需要额外结构输入，不能以随机数代替。
                          </p>
                        </div>
                      </div>
                    </section>

                    <section className="space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-emerald-600">05. AMI 对标与基准测试</h3>
                      <p className="text-sm leading-relaxed opacity-70">
                        发现曲线仅为预设递推的示意动画，不是已拟合模型的对比结果。模型基准脚本和浏览器 Worker 验证页提供合成数据上的真实拟合、预测耗时与留出误差。真实材料精度、不确定性校准和发现加速比仍需单独的受控实验。
                      </p>
                    </section>
                  </>
                )}
              </div>

              <div className="p-8 bg-gray-50 border-t border-gray-100 flex justify-end">
                <button 
                  onClick={() => setShowDocs(false)}
                  className="px-8 py-3 bg-[#141414] text-white text-xs font-bold uppercase tracking-widest rounded-xl hover:bg-black transition-colors"
                >
                  {t.close}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Benchmark Simulator Modal */}
      <AnimatePresence>
        {showBenchmark && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#141414]/40 backdrop-blur-sm p-6"
            onClick={() => setShowBenchmark(false)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-[#F5F5F0] w-full max-w-6xl max-h-[90vh] rounded-[40px] shadow-2xl overflow-hidden flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-8 border-b border-[#141414]/5 flex justify-between items-center bg-white">
                <div>
                  <h2 className="text-2xl font-serif italic font-medium">{t.benchmarkTitle}</h2>
                  <p className="text-[10px] uppercase tracking-widest opacity-40 mt-1">AMI-AL Performance Verification Module • v2.0</p>
                </div>
                <button 
                  onClick={() => setShowBenchmark(false)}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-10">
                <BenchmarkSimulator lang={lang} />
              </div>

              <div className="p-6 bg-white border-t border-[#141414]/5 flex justify-end">
                <button 
                  onClick={() => setShowBenchmark(false)}
                  className="px-8 py-2 bg-[#141414] text-white text-xs font-bold uppercase tracking-widest rounded-xl"
                >
                  {t.close}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {hasOpenedStructure && <React.Fragment key="structure-workspace"><StructurePanel open={showStructure} onClose={() => setShowStructure(false)} lang={lang} materialRequest={structureMaterial} onImportMode={openStructure} /></React.Fragment>}
    </div>
  );
}
