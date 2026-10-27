# AMI-AL Research Framework

> 工业级材料主动学习（Active Learning）优化系统 v2.0
>
> Industrial-Grade Materials Active Learning Optimization System

基于 React + TypeScript + Vite + Express 的 AI4S（AI for Science）原型框架，通过对接 [Materials Project](https://materialsproject.org/) 真实材料数据库，实现贝叶斯优化闭环，加速高性能材料的发现。

---

## 功能特性

- **主动学习闭环**：集成代理模型（Surrogate Model）、获取函数（Acquisition Function）与实验预算管理，支持 UCB / EI / 不确定性采样 / 随机基线等多种策略。
- **七种可选代理模型**：RBF 高斯过程（默认）、随机森林、Extra Trees、梯度提升回归树、kNN、岭回归和 Bootstrap 线性 SGD 基线。训练与批量预测在 Web Worker 中执行，支持取消与固定种子；参数、耗时和不确定性含义在界面展示。
- **真实数据接入**：通过 `/api/materials` 代理接口批量拉取 Materials Project 的锂氧化物（Li-O）材料数据，并自动回退到模拟数据。
- **代价敏感优化**：获取函数按材料的计算代价（原子数、结构复杂度）归一化，优先推荐“单位 DFT 小时价值”更高的候选。
- **多保真特征表示**：13 维材料描述符（10 维成分 + 3 维结构基元），支持同质异构体（polymorph）区分。
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
├── server.ts                          # 本机服务入口，开发/生产资源与关闭清理
├── server/
│   ├── api.ts                        # 材料与聊天代理、取消、脱敏错误
│   └── network.ts                    # 自动代理、HTTPS CONNECT、超时与有限重试
├── vite.config.ts                     # Vite 配置
├── src/
│   ├── App.tsx                        # 主界面与 AL 循环逻辑
│   ├── main.tsx                       # React 挂载
│   ├── types.ts                       # 材料 / AL 状态类型与默认配置
│   ├── components/
│   │   └── BenchmarkSimulator.tsx     # 基准测试弹窗组件
│   ├── engine/
│   │   ├── ActiveLearningLoop.ts         # 有界单轮采样、预算与停止原因
│   │   ├── MaterialsEngine.ts         # 数据加载与特征工程
│   │   ├── SurrogateModel.ts          # 七种回归模型的标准化与统一接口
│   │   ├── ModelWorkerClient.ts       # 任务、取消、超时与隔离的标签边界
│   │   ├── models/                    # RBF GP、CART/森林/GBDT、kNN、Ridge、SGD
│   │   └── AcquisitionFunction.ts     # UCB / EI / Uncertainty / Random
│   └── services/
│       └── MaterialsProjectService.ts # Materials Project API 封装
├── .env.example                       # 环境变量示例
└── package.json
```

---

## 快速开始

### 前置条件

- Node.js 20.19+（20 系列）或 22.12+，与依赖的 Node 要求一致
- npm 或兼容包管理器
- 真实聊天需要 DeepSeek / Kimi / 其他兼容 OpenAI 协议的大模型 API Key
- 真实材料数据需要 Materials Project API Key；没有密钥也可运行 Mock 演示

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

应用默认仅在本机运行：http://127.0.0.1:3000

### 网络连接（自动处理，无需新增配置）

材料与聊天接口共用同一个网络层。有现成代理环境时自动沿用，没有代理时直连；HTTPS 通过 HTTP 代理时使用 CONNECT，避免旧版 Axios 的重复重定向问题。支持已有 HTTP/HTTPS 与 SOCKS 代理，并遵守 `NO_PROXY` 的域名、端口和通配符规则。设置只从启动进程已有的环境读取，不扫描代理端口、不修改系统代理，也不要求在 `.env` 增加网络选项。

材料 GET 最多重试两次暂时性错误，总请求时间有上限；聊天 POST 和 SDK 都关闭自动重试，避免重复计费。材料加载的整体上限为 60 秒，聊天为 45 秒；客户端断开或更换数据加载时会取消旧请求。代理握手同样有固定超时，正在进行的 SOCKS 握手连接最迟在该次超时内清理。401/403 不重试；较长的 `Retry-After` 会直接提示稍后重试。重定向不会自动携带 API 密钥跳转到其他地址。

无法联网、未配密钥或服务拒绝访问时，页面会明确显示原因和 Mock 标记；模拟数据仍可运行，恢复连接后可点击同步；若已开始模拟迭代，先重置再同步。403 不等于密钥必然错误，也可能涉及权限或网络策略。证书校验始终开启；企业网络需要已有可信证书，项目不会通过关闭 TLS 校验来绕过限制。

这些处理不能保证绕过断网、网络封锁、错误密钥或不可用代理。仅在系统界面启用了代理、但启动进程没有继承对应代理环境的场景，不会自动探测系统专用代理配置。部署为对外服务时还需单独规划认证与访问控制；当前默认仅监听本机。

---

## 可用脚本

| 脚本 | 说明 |
|------|------|
| `npm run dev` | 启动 Express + Vite 开发服务器 |
| `npm run build` | 构建生产包到 `dist/` |
| `npm run preview` | 预览生产构建 |
| `npm run lint` | 运行 TypeScript 类型检查（`tsc --noEmit`） |
| `npm test` | 运行采样、数据、EI 及网络/API回归测试；使用本地模拟服务，不需要真实密钥或上游访问 |
| `npm run clean` | 删除 `dist/` 目录 |

---

## 主动学习工作流

1. **数据加载**：启动时从 `/api/materials?limit=` 拉取 Li-O 材料数据，失败时自动使用 Mock 数据。
2. **初始采样**：随机选取最多 `INITIAL_SAMPLES`（默认 5）个材料作为种子，数量不超过可用候选与样本预算；空池禁止运行。
3. **代理模型训练**：按选择的模型拟合已采样数据，特征/目标仅按训练集标准化；后台 Worker 输出预测均值 `μ(x)` 与标准差 `σ(x)`。GP 返回潜在函数后验标准差，其它模型返回集成分歧，含义见[模型说明](docs/surrogate-models.md)。
4. **获取函数计算**：对未采样材料计算 UCB / EI / 不确定性分数。
5. **批量选择**：按获取函数值排序，选取最多 `BATCH_SIZE`（默认 2）个材料，受剩余预算与候选数量约束；计数以实际已采样记录为准。
6. **状态更新**：记录最佳性能、regret 等指标，进入下一轮迭代。

样本预算用完或候选耗尽时停止，空池与停止原因会显示在页面中。`MAX_ITERATIONS` 当前仅保留为配置项，不参与停止判断。

每次数据加载均替换整个数据集，只有最新请求可以提交结果。Mock 模式保留每种组成生成两个模拟多晶型的演示约定，因此请求规模 N 对应 2N 个候选；重复加载不会继续累加，也不会混入此前的真实材料记录。

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

## 代理模型选择与验证

在侧栏“代理模型”中选择模型，展开“模型参数”调整训练种子和相应超参数。开始迭代后参数锁定，需先重置再切换模型。停止、重置、重新加载数据和离开页面均会取消后台计算；旧任务不能覆盖新状态。每项任务最长 30 秒，无同步主线程训练回退。

GPR 使用 RBF 核、Cholesky 分解和训练点距离中位数初始化长度尺度，允许调整尺度倍率和观测噪声；没有自动超参数优化。精确 GPR 最多 256 个训练样本，其它模型最多 1024；最多 128 维特征、每批 20000 个预测。超限会报错，不静默抽样。当前页面预算上限 200，处于 GP 护栏内。候选池数量与训练样本数量不同；没有对所有候选构建完整协方差矩阵。

运行 `npm run benchmark:models` 可输出固定种子、50 个训练样本、1000 个独立合成候选的实际耗时和 RMSE。启动开发服务后打开 `/tests/browser/models.html` 可验证七种真实 Worker、主线程动画、取消和重启。合成数据结果不能作为真实材料精度或发现加速比。

完整实现、参数、复杂度和科学边界见 [docs/surrogate-models.md](docs/surrogate-models.md)。

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

- 当前固定查询 `elements=Li,O`；`limit` 必须是 1–10000 的整数，否则返回 400。
- 若未配置 `MP_API_KEY`，返回 503，错误代码为 `MISSING_API_KEY`。
- 失败返回稳定的 `{error, code, retryable, service}`，可附带 `upstreamStatus`。常见代码包括 `ACCESS_DENIED`、`TIMEOUT`、`PROXY_ERROR`、`DNS_ERROR`、`TLS_ERROR`、`RATE_LIMITED` 和 `REDIRECT_ERROR`，不返回密钥或上游原始错误内容。

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
- 聊天使用与材料相同的自动代理与超时策略，且不会自动重试 POST；缓冲传输目前仅面向本项目 JSON 聊天，不承诺通用文件上传或 SSE 支持。

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
- 当前新增七种轻量回归模型；GP 后验依赖核与噪声假设，树间/Bootstrap 分歧不是已校准置信区间。非 GP 的 EI/UCB 为启发式分数。真实材料适用性需要独立留出集、按组成分组的划分及校准测试；未包含 GNN、SVR、MLP、XGBoost 或 LightGBM。
- 结构描述符（晶格畸变、配位数、电负性差异）目前为模拟值，真实场景应从 Materials Project 结构数据或 `matminer` 提取。
- `DISABLE_HMR=true` 可在 AI Studio 等 agent 编辑环境中禁用 HMR，避免文件监听导致的闪烁。

---

## License

MIT
