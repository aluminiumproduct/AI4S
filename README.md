# AMI-AL Research Framework

> 工业级材料主动学习（Active Learning）优化系统 v2.0
>
> Industrial-Grade Materials Active Learning Optimization System

基于 React + TypeScript + Vite + Express 的 AI4S（AI for Science）原型框架，通过对接 [Materials Project](https://materialsproject.org/) 真实材料数据库，实现贝叶斯优化闭环，加速高性能材料的发现。

---

## 功能特性

- **主动学习闭环**：集成代理模型（Surrogate Model）、获取函数（Acquisition Function）与实验预算管理，支持 UCB / EI / 不确定性采样 / 随机基线等多种策略。
- **真实数据接入**：通过 `/api/materials` 代理接口批量拉取 Materials Project 的锂氧化物（Li-O）材料数据，并自动回退到模拟数据。
- **代价敏感优化**：获取函数按材料的计算代价（原子数、结构复杂度）归一化，优先推荐“单位 DFT 小时价值”更高的候选。
- **内置元素常数与确定性特征**：离线 JSON 包含118种元素记录；按组成计算电负性、共价/参考离子半径、约定价电子数、原子化学硬度的加权均值、总体方差、极差与覆盖率。真实与 Mock 共用同一提取器，不生成随机物理描述符。
- **组成描述符面板**：实时编辑 composition JSON、查看原始单位统计、常数来源与参考态；满足条件时展示 ABO₃ Goldschmidt 容忍因子。
- **双语交互界面**：中英文一键切换，内置系统文档、性能基准（Benchmark）与研究方法论说明。
- **双主题皮肤**：经典模式 / 科研蓝模式。
- **本地大模型接入**：通过兼容 OpenAI 协议的代理接口，可配置 DeepSeek / Kimi 等模型作为 AI 对话后端。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19、TypeScript、Tailwind CSS 4、Recharts、Motion、Lucide React |
| 构建 | Vite 6 |
| 后端 | Express 4、tsx、OpenAI SDK |
| 数据 | Materials Project REST API、axios |

---

## 项目结构

```
AI4S/
├── server.ts                          # Express 服务端入口，代理 MP API 与大模型 API
├── vite.config.ts                     # Vite 配置
├── src/
│   ├── App.tsx                        # 主界面与 AL 循环逻辑
│   ├── main.tsx                       # React 挂载
│   ├── types.ts                       # 材料 / AL 状态类型与默认配置
│   ├── components/
│   │   ├── CompositionDescriptorPanel.tsx # 常数检查、实时组成统计与容忍因子
│   │   └── BenchmarkSimulator.tsx     # 基准测试弹窗组件
│   ├── engine/
│   │   ├── ActiveLearningLoop.ts         # 有界单轮采样、预算与停止原因
│   │   ├── MaterialsEngine.ts         # 数据加载与特征工程
│   │   ├── CompositionFeatures.ts     # 统一组成归一化、物理统计与22维输入
│   │   ├── SeededRandom.ts            # 仅供采样算法使用的显式固定种子
│   │   ├── SurrogateModel.ts          # 集成回归代理模型
│   │   └── AcquisitionFunction.ts     # UCB / EI / Uncertainty / Random
│   └── services/
│       └── MaterialsProjectService.ts # Materials Project API 封装
├── .env.example                       # 环境变量示例
└── package.json
```

---

## 快速开始

### 前置条件

- Node.js（推荐 18+）
- npm 或兼容包管理器
- DeepSeek / Kimi / 其他兼容 OpenAI 协议的大模型 API Key
- Materials Project API Key

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制示例文件：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# DeepSeek API Key（兼容 OpenAI 协议）
# 申请地址：https://platform.deepseek.com/api_keys
DEEPSEEK_API_KEY="你的 DeepSeek API Key"

# 可选：自定义 DeepSeek 兼容端点，默认 https://api.deepseek.com/v1
# DEEPSEEK_BASE_URL="https://api.deepseek.com/v1"

# Materials Project API Key，用于后端拉取材料数据
# 申请地址：https://next-gen.materialsproject.org/api
MP_API_KEY="你的 MP API Key"
```

### 3. 启动开发服务器

```bash
npm run dev
```

应用运行在：http://localhost:3000

---

## 可用脚本

| 脚本 | 说明 |
|------|------|
| `npm run dev` | 启动 Express + Vite 开发服务器 |
| `npm run build` | 构建生产包到 `dist/` |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | 运行 TypeScript 类型检查（`tsc --noEmit`） |
| `npm test` | 运行采样边界、数据加载与 EI 数值回归测试（无需 API 密钥） |
| `npm run clean` | 删除 `dist/` 目录 |

---

## 主动学习工作流

1. **数据加载**：启动时从 `/api/materials?limit=` 拉取 Li-O 材料数据，失败时自动使用 Mock 数据。
2. **初始采样**：随机选取最多 `INITIAL_SAMPLES`（默认 5）个材料作为种子，数量不超过可用候选与样本预算；空池禁止运行。
3. **代理模型训练**：使用集成线性回归器拟合已采样数据，输出预测均值 `μ(x)` 与标准差 `σ(x)`。
4. **获取函数计算**：对未采样材料计算 UCB / EI / 不确定性分数。
5. **批量选择**：按获取函数值排序，选取最多 `BATCH_SIZE`（默认 2）个材料，受剩余预算与候选数量约束；计数以实际已采样记录为准。
6. **状态更新**：记录最佳性能、regret 等指标，进入下一轮迭代。

样本预算用完或候选耗尽时停止，空池与停止原因会显示在页面中。`MAX_ITERATIONS` 当前仅保留为配置项，不参与停止判断。

每次数据加载均替换整个数据集，只有最新请求可以提交结果。Mock 保留每组成两个演示记录（请求 N 对应 2N 条），现在明确标记为 replica；相同组成的描述符与合成目标完全相同，不再假装随机数能区分多晶型。合成分数为 `χ方差 + 0.05×平均原子硬度 + 0.02×平均约定价电子数`，不是材料带隙。重复加载不累加，不混入此前真实记录。

默认配置见 `src/types.ts`：

```ts
AL_CONFIG = {
  INITIAL_SAMPLES: 5,
  BATCH_SIZE: 2,
  MAX_ITERATIONS: 20,
  TOTAL_BUDGET: 50,
}
```

---

## 内置元素常数与统一描述符

`src/data/element-constants.json` 随前端打包，运行时无需联网获取常数。pymatgen 2025.6.14 与 ASE 的上游提交及数据哈希已固定在 JSON 中；可用 `python3 scripts/build-element-constants.py` 从固定版本重建。第三方数据来源和许可证见 `src/data/NOTICE.md` 与 `src/data/licenses/`。

| 属性 | 定义 / 单位 |
|---|---|
| 电负性 | 鲍林标度，无量纲；来自固定版本 pymatgen 元素表 |
| 共价半径 | Cordero 2008 代表值 / Å（ASE 表）；部分为插值；不导入 ASE 缺值占位符 |
| 参考离子半径 | Shannon 有效离子半径 / Å；每元素明确固定价态、CN6及自旋参考，保留完整价态/配位/自旋记录；不是由组成确定的实际离子 |
| 约定价电子数 | 中性原子构型：主族取最外层s/p，d区再含(n−1)d，f区再含(n−2)f；例如Fe=8、Cu=11、Er=14、Lu=17；这是一项明确的计数约定，不等于氧化态 |
| 原子化学硬度 | η=(第一电离能−电子亲和能)/2 / eV；保留两个原始值；不是氧化物键解离能 |

以原子分数 xᵢ=nᵢ/Σnᵢ 为权重：均值 μ=Σxᵢpᵢ，总体方差 σ²=Σxᵢ(pᵢ−μ)²，极差=max(pᵢ)−min(pᵢ)。同一组成不受键顺序或化学式整体倍数影响。Li₂O 的鲍林电负性均值为1.8，方差为1.3448，极差为2.46。

缺值用 JSON `null` 明确记录。只要任一组成元素缺少某属性，该属性的完整统计就为 `null`，不对剩余元素偷偷重新归一化；同时记录已知原子分数覆盖率。模型用0占位配合覆盖率，面板始终显示缺失。无效组成、负计数和未知元素符号显式拒绝。

每类属性提供均值、方差、极差、覆盖率共4维，5类合计20维；再加容忍因子与有效位，共22维，schema为 `ai4s-composition-1.0.0`。`Material.descriptors` 保留原始单位，`features` 按公开固定尺度缩放（χ:4、共价半径:3 Å、参考离子半径:2 Å、价电子:20、硬度:15 eV；方差用尺度平方，t用2），避免直接用大数值方差破坏线性训练。

容忍因子 t=(rA+rO)/[√2(rB+rO)] 仅对两种阳离子组成的 ABO₃ 比例、参考价态电荷平衡、唯一A/B参考位点和可用半径计算。A用CN12、B用CN6、O²⁻用CN6（1.40 Å）；例如 SrTiO₃ 使用Sr²⁺(1.44 Å)和Ti⁴⁺(0.605 Å)。可向提取器传入明确的 `PerovskiteModel` 来选择价态/自旋。其余组成返回不适用，而非伪造数值。即使给出t，也只是参考ABO₃模型下的几何估算，不证明结构或稳定性；混合位点目前需另行建模。

仅凭composition不能区分同质异构体，也不能得到真实晶格畸变或近邻配位数。原先随机结构特征已删除。应用源码不再调用全局随机数；初始采样、bootstrap、随机策略与示意曲线使用显式固定种子，物理特征本身完全不使用伪随机数。

## 后端 API

### `GET /api/materials?limit={number}`

代理查询 Materials Project 的锂氧化物摘要数据。

**响应示例**：

```json
{
  "data": [
    {
      "material_id": "mp-1234",
      "formula_pretty": "Li2O",
      "elements": ["Li", "O"],
      "composition": { "Li": 2, "O": 1 },
      "band_gap": 5.8,
      "formation_energy_per_atom": -2.1
    }
  ],
  "meta": { "total_doc": 150 }
}
```

**说明**：

- 当前固定查询 `elements=Li,O`，`_limit` 最大安全上限为 10,000。
- 若未配置 `MP_API_KEY`，返回 `500` 并提示未配置。
- 若 MP API 403，可能是 API Key 不适用于新版 API（v2）或已被限速/封禁。

### `POST /api/chat`

代理调用 DeepSeek（或兼容 OpenAI 协议）的对话补全接口。

**请求体示例**：

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "You are a helpful materials science assistant." },
    { "role": "user", "content": "推荐一种带隙大于 6 eV 的锂氧化物" }
  ],
  "temperature": 0.7,
  "max_tokens": 2048
}
```

**响应示例**：

```json
{
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 42, "completion_tokens": 128, "total_tokens": 170 }
}
```

**说明**：

- 默认模型为 `deepseek-chat`。
- 支持通过 `DEEPSEEK_BASE_URL` 切换到其他兼容端点（如 Kimi、本地 vLLM 等）。
- 当前仅支持非流式（`stream: false`）响应。

---

## 切换其他大模型

由于接口兼容 OpenAI 协议，只需修改 `.env` 即可切换到 Kimi / 本地模型等：

```env
DEEPSEEK_API_KEY="你的 Kimi API Key"
DEEPSEEK_BASE_URL="https://api.moonshot.cn/v1"
```

前端调用时把请求体里的 `model` 改成对应模型 ID，例如 `moonshot-v1-8k`。

---

## 注意事项

- `.env` 文件已加入 `.gitignore`，请勿将真实 API Key 提交到仓库。
- 当前代理模型使用集成线性回归器做演示，生产环境建议替换为高斯过程回归（GPR）或图神经网络（GNN）。
- 元素常数是注明参考约定的原子/离子数据，缺值与条件依赖均保留；真实结构描述符仍需要额外结构输入。策略示意动画不是实测性能基准，不提供加速倍率或预测精度证据。
- `DISABLE_HMR=true` 可在 AI Studio 等 agent 编辑环境中禁用 HMR，避免文件监听导致的闪烁。

---

## License

MIT
