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
- **多保真特征表示**：13 维材料描述符（10 维成分 + 3 维结构基元），支持同质异构体（polymorph）区分。
- **双语交互界面**：中英文一键切换，内置系统文档、性能基准（Benchmark）与研究方法论说明。
- **双主题皮肤**：经典模式 / 科研蓝模式。
- **结构导入与 3D 查看**：在浏览器本地导入 CIF / POSCAR / CONTCAR，检查晶胞、元素占位、周期复制及位点距离；不需要 uMLIP 或 API 密钥。
- **推荐材料结构查看**：点击推荐材料行或化学式，按 Materials Project 材料 ID 获取真实晶胞并缓存；Mock 明确显示“暂无结构”。数据库结构获取需要已有的 `MP_API_KEY`。
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
│   │   ├── BenchmarkSimulator.tsx     # 基准测试弹窗组件
│   │   ├── StructurePanel.tsx         # 按需加载与独立错误边界
│   │   ├── StructureWorkspace.tsx     # 本地导入、结构元数据、位点与测距
│   │   └── StructureViewer.tsx        # Three.js 原子、晶胞与几何邻接线
│   ├── structures/                    # 结构类型、Worker、CIF/POSCAR 归一化和周期几何
│   ├── engine/
│   │   ├── ActiveLearningLoop.ts         # 有界单轮采样、预算与停止原因
│   │   ├── MaterialsEngine.ts         # 数据加载与特征工程
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
3. **代理模型训练**：使用集成线性回归器拟合已采样数据，输出预测均值 `μ(x)` 与标准差 `σ(x)`。
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

## 结构导入与 3D 查看

点击页头“结构导入 / 3D”，选择或拖入文件，也可以粘贴文本。查看器提供明确标记的理想 SrTiO3 / NaCl 演示结构，支持旋转、缩放、平移、复位视角、晶胞边框、1×1×1 / 2×2×2 显示、原子选择和两点测距。位点表可以搜索；多数据块 CIF 可以选择要显示的数据块。

- 文件在本地 Web Worker 内解析，不发送到服务端、材料数据库或大模型。保留文件原文、来源文件名、CIF 数据块和占位信息；关闭窗口后保留当前页面会话，刷新页面会清空。
- CIF 1.1：支持常见晶格参数、分数或 Cartesian 坐标、括号不确定度、显式现代/旧式对称操作、特殊位置去重和混占。Cartesian 坐标支持显式变换矩阵和平移；缺少矩阵时采用标准晶胞轴向并提示。对称操作须保持晶格度量。同元素部分占位的等价重叠存在歧义时拒绝自动累加。未提供操作且不能确认为 P1 时，仅显示已列位点并提示未完成对称重建；空间群仅展示文件声明，未进行识别。
- POSCAR / CONTCAR：支持带元素行的 VASP 5 格式、Direct / Cartesian / K 模式、正标量缩放、负体积缩放、三个正 Cartesian 分量缩放和 Selective dynamics。保留 T/F；不读取速度与预测校正附加段。缺元素的 VASP 4 文件不会从标题猜测元素。
- “几何邻接线”只是当前显示坐标的距离截断，不等同于化学键或配位判定；默认截断可调整，最多显示 8000 条。测距同时显示所选周期映像间的直接距离和基于原晶格的最小周期距离，后者包含三斜晶胞处理。
- 当前限制：5 MB、最多 5000 个展开/显示位点、单次解析 10 秒；大于 1200 个显示位点时关闭邻接线。暂不支持 CIF 2.0 和 save frames。对于缺失数值、无效晶胞或无法可靠解释的占位，会提示错误并保留上一份有效结构。

结构使用独立的 `CrystalStructure` 类型，不生成 `trueProperty`，不进入现有主动学习训练池，也不自动替换原来的模拟特征。此版本只完成结构输入和查看，不包含 uMLIP、结构优化、带隙计算或掺杂前后比较。

渲染使用 Three.js（按需加载），CIF 词法/语法读取使用 `crystcif-parse` 的纯解析入口；晶格归一化、对称操作校验、占位处理和周期几何在项目的 `src/structures/` 中实现并有回归测试。

### 从推荐材料查看数据库结构

点击推荐列表中的材料行，或化学式旁的“查看 3D”。列表同步仍只下载性质摘要；点击时才通过后端按该记录的材料 ID 请求 `material_id,formula_pretty,structure,symmetry`，不会按化学式猜测结构。同一化学式下的不同材料 ID 独立缓存。使用数据库返回的完整 pymatgen 晶胞和分数坐标，不再进行对称展开，查看器显示材料 ID、数据源、获取时间及缓存状态。

浏览器会话与本地服务各有 30 分钟内存 LRU 缓存，各自最多 64 项、序列化数据合计 20 MB；过期后重新获取，刷新页面或重启服务分别清空相应缓存。仅成功且通过 ID/几何/占位检查的结构进入缓存。缺少结构、网络失败、认证失败、无效响应及取消的请求不会缓存，页面提供重试。切换材料或关闭查看器会取消旧请求，旧材料的结果不会覆盖当前材料。

Mock 和未确认来源的记录不会发送结构请求，也不会使用演示结构代替，页面显示“暂无结构”。本地文件导入状态独立保留，可从查看器切回。查看数据库结构不会改变主动学习的标签、样本计数、排序或训练数据；结构特征提取及 uMLIP 仍未接入。

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

### `GET /api/materials/:materialId/structure`

按单个 `mp-…` / `mvc-…` ID 获取结构，兼容数字及新版字母数字 ID；格式无效的 ID 返回 400。密钥只在后端使用，沿用既有自动代理、证书验证、超时及取消处理。成功返回 `{data: {material_id, formula_pretty, structure, symmetry}, meta: {materialId, fetchedAt, cached}}`。缓存策略见上节；无对应结构返回 404 / `STRUCTURE_NOT_FOUND`，失败返回脱敏错误而不会回退为演示结构。

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
- 当前代理模型使用集成线性回归器做演示，生产环境建议替换为高斯过程回归（GPR）或图神经网络（GNN）。
- 结构描述符（晶格畸变、配位数、电负性差异）目前为模拟值，真实场景应从 Materials Project 结构数据或 `matminer` 提取。
- `DISABLE_HMR=true` 可在 AI Studio 等 agent 编辑环境中禁用 HMR，避免文件监听导致的闪烁。

---

## License

MIT
