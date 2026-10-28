# 多源多保真 Data Hub

Data Hub 将候选数据集与代理模型分开：切换数据源或优化目标会取消旧加载/Worker、清除旧预测和顾问历史，再建立新的数据快照。主界面不再将在线错误替换成合成 Mock 标签。

## 四种数据模式

| 模式 | 数据来源与行为 |
| --- | --- |
| 实时 MP | 查询 Materials Project summary，成功结果写入 SQLite。失联、缺 key 或403等失败时，明确标注原因并读取同一筛选条件的真实本地快照。 |
| 离线 MP | 只读本地 SQLite 的 MP 记录及完整结构，不需要 key，不向 MP 发请求。 |
| 催化 / 电极 | 用户导入有引用、单位、方法和条件组的 DFT/MLIP/实验观测。当前没有提供真实特色数据集，因此初始为空。 |
| DFT + 实验 | 用户导入同目标、同单位且有配对依据的记录。学习池使用实验目标，另有独立的常数偏差校准；当前初始为空。 |

空库、缺失目标和无匹配筛选都保持为空，不造值、不将缺值补为0，不把文件导入自动视作已验证科学证据。

## 启动与捕获真实快照

```bash
npm ci
cp .env.example .env
# 在本机 .env 填写已有 MP_API_KEY；聊天另需 DEEPSEEK_API_KEY。
npm run hub:capture -- --elements Li,O --limit 20
npm run hub:capture -- --elements Pr,Ba,Co,O --limit 20
npm run hub:capture -- --elements Sr,Ti,O --match exact --limit 20
PORT=4312 npm run dev
```

并行工作树可选择不同 `PORT`；开发热更新端口默认随HTTP端口分别偏移10000，也可设置 `HMR_PORT`。生产预览可先构建，再使用 `NODE_ENV=production PORT=4312 npm run dev`，不会启动Vite热更新服务。

数据库默认是项目内的 `data/ai4s_hub.db`，可用 `AI4S_HUB_DB` 指定本地路径。数据库、WAL及密钥文件均被 Git 忽略；新克隆不会自动得到本机快照，需捕获数据或单独迁移数据库。没有快照且没有 key 时，界面显示空状态，应用仍能启动。

SQLite 原生依赖为已安装的 `better-sqlite3`。表包括 `mp_snapshot`、`catalysis_records`、`dual_fidelity_pairs`，以及 schema 信息与 MP 历史版本表。导入采用事务；已有实验观测 ID 不允许覆盖，需给不同观测独立 ID。在线 MP 更新会保留旧记录版本；结构引用携带 dataset/id/内容哈希，避免更新快照后误用旧缓存。

## 查询与目标

- 包含元素 `Pr,Ba,Co,O`：每种元素均需出现，允许其他元素。
- 精确体系：使用 MP 的 `chemsys`，只含所列元素。
- 排除元素 `Au,Pt,Ir`：记录不得包含任一排除元素；包含与排除不能交叠。
- 不同测量条件或配对口径用 `cohort` 分组；一次寻优不能静默混合多个条件组。
- MP 默认请求 `license=BY-C`，不自动接入 GNoME 非商业许可数据。`GNoME-Extrapolated` 只是来源契约的预留标签，并非已内置的数据库提供者。

| 目标 ID | 原始单位 | 默认方向 |
| --- | --- | --- |
| `band-gap` | eV | 最大化 |
| `formation-energy` | eV/atom | 最小化 |
| `energy-above-hull` | eV/atom | 最小化 |
| `vacancy-energy` | eV | 最小化 |
| `bond-energy` | eV，正值键解离能约定 | 最大化 |
| `polarization-resistance` | Ω·cm² | 最小化 |
| `overpotential` | mV | 最小化 |

MP 当前字段是 `energy_above_hull`，不是旧版的 `e_above_hull`。summary 请求同时读取 band gap、formation energy、hull energy、structure、symmetry 和 origins。缺少所选目标的记录被排除并计数。模型训练保留原始数值；只有获取分数按方向转换，最小化的 regret 为已观察最小值减全池最小值。负分和零分候选仍可显示。

目标方向是显式优化规则，不代表普适材料设计结论；例如较低空位形成能不自动意味着更好的电极性能。键解离能、ICOHP和原子硬度不是同一个量，不应互换目标名称或符号。

## 导入契约

界面“导入有来源的数据”提供 JSON 模板和本地 JSON 文件读取。模板含 `null` 目标和待填写来源，不能直接作为观测导入。每次1–500条，总 JSON≤8MB；单个结构≤5MB、最多5000个位点。

催化库载荷为 `{ "dataset": "catalysis-hub", "records": [...] }`。每条记录包含：

- `id`、`formula`、`composition`；
- `values`：以目标 ID 为键的有限数值；`units` 中逐项明确单位；
- `source`：`MP-DFT` / `Catalysis-Hub` / `GNoME-Extrapolated` / `Lab-Experiment`；
- `fidelity`：`low-dft` / `mid-umlip` / `high-exp`，是方法层级标签，不保证精度顺序；
- `methodMeta`：泛函、U、磁态、参考能，或实验方法、温度、测试归一化等；
- `cohort`：可比较的测量条件/定义；
- `provenance`：真实引用 `reference`、无凭据 HTTP(S) `url`、`datasetVersion`、`retrievedAt`、`license`，可附 originating `taskIds`；
- 可选完整 pymatgen `structure` / `symmetry`，不从化学式猜坐标。占位归一化组成必须与记录组成一致，允许整体超胞倍数；结构可用单独的 `structureProvenance` 保留来源，不能沿用不同实验观测的来源。

一条普通记录的目标应属于同一方法/保真度。DFT与实验值不要塞进同一个普通记录并共享一个 fidelity；应使用配对契约。字段校验不等于独立核验文献、数据真实性或实验可比性。

配对载荷为 `{ "dataset": "dual-fidelity", "pairs": [...] }`。每个 pair 包含上述身份、组成和cohort，另有 `objective`、`unit`、`comparisonBasis`，以及 `dft` 和 `experiment` 两个独立观测；各自有 `value`、`methodMeta`、`provenance`。配对结构默认使用DFT观测的来源，也可显式提供 `structureProvenance`；结构获取时间与引用独立于实验标签。不能仅凭同化学式认定结构、相或测量目标可比。

## 10组校准与验证

当前提供透明的常数偏差模型：`实验估计 = DFT + mean(实验−DFT)`。

仅在同目标、单位和配对cohort内计算。按归一化组成分组，重复组成/多晶型不跨校准与留出集合；每组按ID选择一条代表记录，以固定种子42划分。使用10组校准值拟合偏差；其余组为独立留出，至少2组时才报告原DFT与修正后MAE。只有10组时可拟合，但验证指标为 `null`。误差可能变差，应如实报告。

这不是多保真GP、自动实验执行或因果模型。常数校准不修改原始记录，不自动补全未测实验标签；现有AL仍为已有观测的离线回放。

## API 与代码位置

| 路由 | 用途 |
| --- | --- |
| `GET /api/hub/catalog` | 三张本地库的记录数、条件组和更新时间 |
| `GET /api/hub/materials?source=mp-snapshot&objective=formation-energy&elements=Pr,Ba,Co,O` | 查询数据集及来源/版本/回退元信息 |
| `GET /api/hub/structure?dataset=mp-snapshot&id=…&revision=…` | 读取指定版本的本地结构 |
| `GET /api/hub/template?dataset=catalysis-hub` | 获取必须补齐的空值模板 |
| `POST /api/hub/import` | 校验并原子写入特色或配对数据 |
| `POST /api/hub/calibrate` | 对指定objective/cohort做10组偏差校准 |

原 `/api/materials` 和 `/api/materials/:id/structure` 保留兼容，同时支持元素筛选及扩展字段；旧 `loadRealData` 的合成回退仅保留给兼容调用和旧测试，主界面使用新的 `loadHubData`。

核心模块：`src/dataHub.ts`（共享契约）、`server/hubStore.ts`（SQLite与校验）、`server/mpProvider.ts`（在线MP）、`server/hubRoutes.ts`（API）、`src/components/DataHubPanel.tsx`（四源切换）、`src/engine/DualFidelityCalibration.ts`（校准）。顾问快照保留目标方向、单位、数据集版本及逐记录血统，不发送未采样高保真标签或结构文件。

## 来源、许可与证据

本地MP记录保留材料链接、引用、获取时间、API返回的数据库版本和可取得的 origins task IDs。API未提供数据库版本时明确记为未提供，不将客户端版本或日期伪装成数据库版本。`BY-C` 是API许可筛选标签，不把它自行解释为所有记录统一许可；导出或再分发前需核对原始条款。

- [MP 查询与来源追踪](https://docs.materialsproject.org/downloading-data/using-the-api/querying-data)
- [MP summary 官方客户端](https://materialsproject.github.io/api/_modules/mp_api/client/routes/materials/summary.html)
- [MP 数据库版本与 GNoME 说明](https://docs.materialsproject.org/changes/database-versions)
- [MP 引用说明与 FAQ](https://docs.materialsproject.org/frequently-asked-questions)

验证命令：`npm run lint`、`npm test`、`npm run build`。新增 `tests/DataHub.test.ts` 覆盖SQLite持久化/事务/历史结构、空库、元素筛选、403/缺key真实回退、目标最小化、源/单位校验、按组成隔离的校准及高保真标签隔离。
