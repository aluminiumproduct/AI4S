# 同成分构型 uMLIP 主动学习

本模块在本机实际调用 MACE/ASE，固定晶胞弛豫一组元素计数完全相同的原子构型，并最小化模型预测的弛豫后能量。它与原带隙／Mock 演示独立，不使用预存能量标签，不执行 DFT 或实验，也不计算形成能、凸包距离或迁移势垒。

## 运行依赖

Web 部分仍使用 Node.js；计算额外需要 Python 3.11、ASE、PyTorch、mace-torch 和本地通用 MACE checkpoint。

```bash
python3.11 -m venv .venv-umlip
.venv-umlip/bin/pip install -r requirements-umlip.txt
```

将运行时配置写入被 Git 忽略的 `.env.umlip.local`，或在启动服务的环境中设置。已有 `.env` 的值优先；前端不会获得这些路径。

```dotenv
UMLIP_PYTHON=/absolute/path/to/python
UMLIP_MODEL_PATH=/absolute/path/to/generic-mace.model
UMLIP_THREADS=2
# 可选，本地结果目录；默认当前工作树的 umlip-results/
# UMLIP_OUTPUT_DIR=/absolute/path/to/results
```

默认也会查找 `.venv-umlip/bin/python` 和 `~/.cache/mace/macempa0mediummodel`。不在运行过程中下载权重、切换模型或退回模拟能量。通过 `torch.load(..., weights_only=False)` 载入本机可信权重；只应配置可信来源 checkpoint。模型标签不能替代 SHA256 或适用性验证。当前验证使用通用 MACE-MPA-0 medium，而非 PrBaCo 专用微调模型。

```bash
npm run dev
# 若本机 3000 已有其他服务，可为本工作树指定端口
PORT=4311 npm run dev
```

在页头打开“uMLIP 构型寻优”。导入多个 CIF / POSCAR / CONTCAR；一个 CIF 的多个数据块也可成为候选。可用六个理想／位移扰动 SrTiO3 示例检查流程；它们没有 DFT 真值，可能弛豫至同一极小值，不能作为多晶型发现或模型准确性证据。

## 结构与比较条件

- 2–32 个构型，每个 1–128 原子。元素计数、元素顺序、运动约束须完全一致；不能混合不同超胞倍数、掺杂浓度或组成。
- 仅支持满占位、有序、三维周期晶体。混占或部分占位先显式有序化。仅列出非对称单元且未完成对称展开的 CIF 不可用于计算。
- 所有计算使用同一运行的同一权重／SHA256、CPU、float64、FIRE、`maxstep=0.15 Å`。每个构型保持自己的初始晶胞；比较的是指定固定晶胞条件下的模型弛豫能，而非零压力平衡态焓。
- 保留原子顺序和 Selective dynamics。VASP T/F 按 Direct 基矢解释，通过 ASE `FixScaled` 实现；不是笛卡尔方向掩码。报告投影后自由度最大受力，并另存原始最大受力。
- 首版没有指定电荷态、磁序分支或用户 U 值的接口。不同 checkpoint／参考方法的结果不能混作一条训练历史。
- 输入与输出均检查晶胞、数值、组成、约束和至少 0.5 Å 的周期原子间距。该阈值是碰撞防护，不是化学合理性或模型适用性保证。

## 在线学习和标签

1. 第一批包含列表首个参考候选及固定种子的其他候选，默认两个。
2. 后续仅使用已收敛观测，以初始几何描述符训练 GPR，选择 `μ(E/atom) − 2σ` 最小的一批；一批内按选定顺序串行弛豫，下一批重新拟合。
3. 描述符版本 `periodic-pair-rbf-v1`：周期最短原子对距离的平滑 RBF 统计、原子序数加权统计及晶胞大小指标。它是确定性几何表示，不是 MACE 隐空间、完备结构指纹或已校准的化学距离。
4. GPR 内部以 `−E/atom` 训练，以便复用数值核心；采集和界面统一转换为能量最小化，不读取未计算构型的标签，不显示全池真实最优值或 oracle regret。
5. 第一个通过收敛验收的构型固定参考能 `Eref`。后续始终回填 `ΔE = E − Eref` 及每原子相对能；参考不会被后来的更低能结果替换。负 ΔE 表示比参考低能。
6. 未收敛、失败、取消的结果不进入训练。未收敛能量和轨迹可查看，但不标为有效相对能标签；没有任何收敛结果的运行标为失败。

默认 `fmax=0.08 eV/Å`、最多100离子步，允许范围为 0.005–1 eV/Å、1–200步。达到步数上限不等于收敛。收敛只针对 MLIP 势函数及当前约束，不证明 DFT 收敛或稳定相。

预算计算每次尝试，包括失败和未收敛。一次只运行一个本地计算任务。每轮默认两个；支持取消、查看逐步坐标／能量／受力、恢复已保存记录和下载 POSCAR／JSONL 轨迹。关闭面板后服务端继续运行；“取消计算”才会终止计算进程。服务重启时，未完成任务标为中断，保留已落盘结果，不偷偷续算。

## 时间与溯源

结果位于 `umlip-results/<run UUID>/`，默认被 Git 忽略：

```text
run.json                         # 构型、输入哈希、选择依据、观测、固定参考、轮次及状态
<candidate ID>/input.json         # 计算输入、方法参数、模型元数据
<candidate ID>/optimizer.log      # 实际 FIRE 日志
<candidate ID>/trajectory.jsonl   # 逐步能量、最大受力、坐标和实测耗时
<candidate ID>/relaxation.traj    # ASE 原始轨迹
<candidate ID>/POSCAR.relaxed     # 包括未收敛时的最后结构，状态须以 result.json 为准
<candidate ID>/result.json        # 能量、收敛、步数、耗时和最终结构
<candidate ID>/failure.json       # 有输出目录时保存的计算失败原因
```

记录权重 SHA256、运行脚本 SHA256、包版本、设备、精度、线程数、方法参数及结构哈希。模型启动加载耗时与每个构型的实际弛豫耗时分开；端到端耗时另计，包括启动、通信、拟合和本地保存开销。每次运行复用同一已加载模型，不承诺固定秒数。

接口仅允许本机同源访问。模型路径、Python 路径和输出根目录由服务端环境控制，不能通过浏览器请求指定任意路径或命令。

## 验证

```bash
npm test                 # 无需 MACE 的输入、标签、取消、参考、API 回归；使用明确的测试替身
npm run lint
npm run build
npm run verify:umlip     # 实际载入本地 MACE 权重，执行两轮、四构型弛豫；需要计算依赖
```

实际验证脚本将完整结果保留在新的 UUID 目录，不覆盖旧结果。网页可检查真实进度、未收敛状态、取消、下载和恢复。首次大规模筛选前，仍需针对目标化学体系独立验证模型的能量、力和几何，并与统一设置下的 DFT 对照。
