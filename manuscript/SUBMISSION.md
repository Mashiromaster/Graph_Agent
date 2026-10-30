# 投稿前检查清单

## 已完成且已验证

### 正文
- **页数**:正文第 11 页结束(TMLR 上限 12),全文 13 页含参考文献与附录。
  用 `\label{marker:endbody}` 插桩实测,不是估算——"全文 13 页"不等于
  "正文 13 页",而 TMLR 卡的是正文。
- **编译**:`latexmk -pdf -bibtex main.tex` exit 0,零未定义引用、零未定义
  交叉引用、零 overfull box。官方 `tmlr.sty` / `fancyhdr.sty` / `tmlr.bst`
  随稿存放。
- **`\TODO` 归零**(正文)。附录尚有 5 个,见下。

### 双盲
- 手稿与 bib 中无作者名、机构、GitHub org。`refs.bib` 里的 GitHub URL 是
  第三方引文(LangGraph / CrewAI / Swarm 的项目地址),应当保留。
- 补充材料打包脚本 `scripts/package-supplementary.sh` 采用**白名单纳入 +
  打包后重扫**:白名单防纳入过多,重扫防白名单本身写错。泄漏时退出码非零,
  可用作发布门禁。
- 扫描覆盖:用户名、分支名、端点主机名、提交者邮箱、
  `/Users/<name>/` 绝对路径。当前结果 **clean**。
- `results/records.jsonl` 的 `model` 字段记为档位标签(`small`/`mid`)而非
  厂商型号;126 份 transcript 均不含真实型号名或端点主机名。

### 补充材料
- 2.8M / 326 文件,远低于 TMLR 的 100MB 上限。
- **已在干净临时目录实测**:解包后 `npm install && npm run build &&
  npm test` → 740 测试全通过,全程无网络。
- **论文数字可从包内复算**(已验证逐项吻合):

  | 量 | 包内复算 | 手稿 |
  |---|---|---|
  | A1 质量 / token | 0.646 / 8449 | 0.646 / 8449 |
  | A5 质量 / token | 0.764 / 25172 | 0.764 / 25172 |
  | 配对 Δ (A1→A5) | +0.118 ± 0.092 | +0.118 ± 0.092 |
  | 关 fan-in | +0.047,不显著 | +0.047,不显著 |
  | 摘要一致性 | 118/118 | 118/118 |

### 许可
- 代码 Apache-2.0,论文 CC BY 4.0(TMLR 自投稿起强制)。两者兼容:
  Apache-2.0 允许再分发,CC BY 4.0 仅约束论文文本本身。
- **八个 package 的外部运行时依赖均为 none**,故 artifact 不携带第三方
  许可义务。`THIRD_PARTY_NOTICES.md` 记录的 vendored 上游
  (`awesome-llm-apps/`,Apache-2.0)**未纳入**补充材料包,已核实。

## 投稿时需手动完成

1. **样式切换**:`main.tex` 现用 `\usepackage{tmlr}`(评审期匿名)。
   camera-ready 换 `[accepted]`;若先发 arXiv 预印本用 `[preprint]`。
2. **作者块**:现为 `\author{\name Anonymous \email anonymous@example.com}`。
   评审期 `tmlr.sty` 自动匿名化,此处内容不显示;camera-ready 时填真实信息。
3. **OpenReview profile**:全部作者须补全 affiliation / COI /
   publication history。这是硬性校验,缺了会卡住提交。
4. **推荐 Action Editor**:提交时需指定,从 TMLR 的 AE 列表里挑一位
   做 agent / 软件工程方向的。
5. **正文 ≤12 页**:这一条把审稿期从 4 周压到 2 周。当前第 11 页结束,
   若后续增补内容需重新实测页码。

## 已知缺口(建议在投稿前补,但不阻塞)

- **附录 5 处 `\TODO`**:14 框架详表、~20 个拒绝码清单、哈希链与
  checkpoint v1/v2 schema、逐实例结果表、已声明不做的机制(学习型拓扑
  优化器 / 隐状态残差 / 端到端 RL)。附录不计页数且审稿人无义务读,
  但 artifact 的完整性会被看。
- **故障注入臂未跑**:机制已实现(`faultyModelFactory` +
  `minTrustScore` 门),因配额耗尽未执行。§7 已如实记录。
- **frontier 档已排除**:§5 写明原因(该档 thinking 占输出预算 80%,
  端点侧上限使公平比较不可达)。跨模型结论仅覆盖两档。

## 复算命令

```sh
# 手稿
cd manuscript && latexmk -pdf -bibtex main.tex   # 需 /Library/TeX/texbin 在 PATH

# 补充材料(含匿名扫描,泄漏则退出码非零)
./scripts/package-supplementary.sh

# 离线全量测试
npm install && npm run build && npm test          # 740 tests
```
