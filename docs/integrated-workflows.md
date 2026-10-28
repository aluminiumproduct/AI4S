# 五功能整合工作流

## 数据与目标

Data Hub 为主数据入口：实时/离线 MP、特色观测、DFT与实验配对。空库和网络失败保留明确状态，不生成替代实验值。观察值维持原单位，七种目标的最大化/最小化方向贯穿采样、顾问与公式展示。

每条记录保留数据集、来源、保真度、方法、条件组、引用、版本及结构引用。公式与帕累托导出不携带未采样隐藏标签；公式补充量及外部稳定性导入在数据集变化时清理，避免同名ID跨来源串用。

## 各模块的衔接

- **uMLIP**：独立的同成分固定晶胞能量最小化，只有收敛的MACE观测进入训练。不会把总能当作带隙或MP形成能。
- **白盒公式**：从当前目标读取单位与方向；原单位描述符、条件组隔离、教师/真实标签边界保留。最小化目标的优选图突出低值。
- **帕累托**：演示组合可独立运行。真实入口当前明确限定MP带隙最大化、Ehull最小化及采购价最小化；其他Hub目标仍用于单目标及公式流程，不被冒称为带隙。保留零Ehull与缺值语义。
- **合成/XRD**：pymatgen负责模拟谱；预审是启发式，参考谱系数不是Rietveld质量纯度。显示“谱图匹配”，不显示“实验已验证”。

## XRD反馈边界

真实反馈需来自当前记录的数据库结构解析路径，携带结构SHA256及精确dataset/id/revision引用，并与Engine独立计算的预期几何摘要比对；关联同组成的导入晶胞仍可分析，但不能替代该数据库晶胞的反馈资格。数据库结构失败时报告错误，不回退演示晶胞。预审读取同一快照版本的Ehull，不按裸ID另取其他来源或新版数据；缺少稳定性时显示未知，不补演示值。

演示谱仅能影响Mock候选。演示晶胞、演示谱或旧版无绑定摘要均不能改变真实候选的排序。下载的演示谱保留证据标记，改名后重导入也不会自动变成实验数据。用户上传谱仍需人工核验来源。

v2反馈按记录身份保存，切换数据来源、版本或条件组不会串用同名ID；重复回填替换旧先验，不重复乘惩罚，不改变目标标签和采样状态。旧实验报告保留供查看，旧v1反馈不自动生效。

## 本地运行

```bash
npm ci
npm run setup:synthesis
# uMLIP需要独立Python/MACE依赖，详见umlip-active-learning.md。
PORT=4325 DISABLE_HMR=true npm run dev
```

已有科学Python可用`AI4S_PYTHON=/absolute/path/to/python`，uMLIP使用`UMLIP_PYTHON`、`UMLIP_MODEL_PATH`与可选`UMLIP_OUTPUT_DIR`。服务与`verify:umlip`都先读取`.env`再读取`.env.umlip.local`；不自动下载权重。SQLite默认`data/ai4s_hub.db`，可用`AI4S_HUB_DB`隔离验证库。密钥、数据库、模型权重和运行结果不提交Git。

## 联合回归

```bash
npm run lint
npm test
npm run build
npm run verify:umlip
```

`FiveFeatureIntegration.test.ts`覆盖SQLite→HTTP→Engine→Pareto、非带隙最小化→公式/顾问、目标单位及记录血统、真实结构引用、演示/导入/版本反馈隔离、幂等性、路由共存及大请求体。Python数值回归在配置的科学Python可用时执行；缺依赖的skip不等于真实数值验证。`verify:umlip`另行实际加载本地权重并计算四个小构型，结果不证明DFT精度或相稳定性。
