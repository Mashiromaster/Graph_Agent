# 手稿与实验:当前状态与收尾步骤

TMLR 投稿的手稿骨架与实验管线已就位。本文件记录**还差什么**,以及拿到前置条件后
的确切操作顺序。

## 两个外部阻塞项

### 1. LaTeX 工具链(本机缺失)

`pdflatex` / `latexmk` / `tectonic` / `xelatex` / `bibtex` / `biber` 全部不存在。
`main.tex` 因此从未编译过——它的 LaTeX 语法未经验证。

```sh
# macOS
brew install --cask mactex-no-gui    # 或 basictex(更小,需自行补包)
```

同时必须从 <https://jmlr.org/tmlr/> 下载**官方 `tmlr.sty`** 放入本目录,并把
`main.tex` 开头的占位 `\usepackage[preprint]{neurips_2024}` 换成:

```latex
\usepackage{tmlr}              % 评审阶段(匿名)
% \usepackage[accepted]{tmlr}  % camera-ready
```

格式违规是 desk reject 的理由,不要用自制样式凑。

### 2. 模型凭据(本机缺失)

需要 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 之类——具体变量名由
`packages/bench/src/models.ts` 的 `ModelSpec.apiKeyEnv` 指定。

本机环境里有 `ANTHROPIC_AUTH_TOKEN`,但那是 Claude Code 会话自身的凭据,
**未经明确授权不得用于跑实验**。

`MODEL_MATRIX_TEMPLATE` 里的 `model` 字段是 `<fill-in>`:刻意不写死型号,
避免把一份会过期的清单固化进源码。填入时同时确认 `temperature`——它经
`extraBody` 进入请求体,因为 `OpenAICompatibleModel` 没有专门的 temperature
参数。

## 已经可以验证的部分

全套 698 个测试(62 文件)离线通过,`npm run typecheck` 干净。这覆盖了:

- 确定性关卡:录一次 `AgentNode` 全栈运行,在 3 并发度 × 3 乱序下重放同一份
  transcript,9 次摘要唯一(`packages/node/test/replay-determinism.integration.test.ts`)。
- 投递未扰动摘要的回归证明:`checkpoint-v2.test.ts`、`resume.integration.test.ts`、
  `resume-e2e.test.ts` **逐字节未改**且全绿。
- 端到端实验演练:多臂 × 多题 × 多种子 → JSONL → 汇总 / 配对比较 / Pareto /
  权重扫描 / 摘要一致性(`packages/bench/test/pipeline.integration.test.ts`)。
- 沙箱对抗测试 27 项(`packages/bench/test/codegen-sandbox.test.ts`)。

## 收尾顺序

1. **装 LaTeX + 换官方样式**,`latexmk -pdf main.tex` 编译通过。先做这步:
   它不依赖实验,且会暴露 `main.tex` 里尚未验证的语法问题。
2. **填 `MODEL_MATRIX_TEMPLATE`** 的型号与凭据变量名,设置对应环境变量。
3. **跑一格冒烟测试**(单模型、A1、1 题、1 种子),确认实况链路通。预期会有
   首次接触的意外:A4/A5 用的是已发布 Studio 从未走过的 policy
   (它硬编码 `allowDirectMessages: false, allowSkipContext: false`)。
4. **验证实况确定性**:把第 3 步存下的 transcript 用 `replayFactoryFrom` 离线
   重放,断言摘要一致。**这是 stop-the-line 关卡**——匹配率不足 100% 意味着
   存在未发现的非确定性源,确定性主线即破,必须先解决再往下跑。
5. **跑分层网格**。`plannedCells` + `estimateCost` 可在跑前算出总格数与 token
   估算,核对预算后再启动。`runGrid` 逐行落盘且支持幂等重入,中途失败
   (限流/配额)不丢已完成的工作:用 `loadCompletedKeys` 重入即可。
6. **填 §6 的数字**。`main.tex` 里所有 `\TODO` 标记处均为待测量项;在实验跑完
   之前不要填入任何占位数值。
7. **双盲卫生**:剥离作者名、GitHub org、分支名 `Mashiromaster/paper`;
   匿名化补充材料 ZIP(上限 100 MB)。核对 `LICENSE` 与
   `THIRD_PARTY_NOTICES.md` 与 CC BY 4.0 的兼容性(TMLR 自投稿起即要求该许可)。
8. **把 transcript 作为补充材料提交**。这是手上最强的单项严谨性资产:
   审稿人据此可零 API 成本复算每个数字,并自行验证「运行时贡献零熵」。

## 页数纪律

正文 ≤12 页(不含参考文献与附录)把 TMLR 审稿期从 4 周压到 2 周。`main.tex`
的章节页数预算已按此分配(1.25 / 1.0 / 2.5 / 2.0 / 1.5 / 2.75 / 1.0 = 12.0)。
附录不计页数,但审稿人没有义务读它——不要把正文论证搬进附录来腾页数。

## 必须精确表述的一条声明

确定性**以模型为条件**。temperature > 0 的实况运行不是 bit-identical,不要那样
写。可检验且更强的表述是:

> 运行时贡献零熵:给定已记录的模型响应序列,最终快照摘要与并发度、调度、
> 完成顺序无关地 bit-exact 可复现。

## 代码沙箱的如实表述

codegen 评分器执行模型生成的代码,采用**进程级隔离**:独立子进程、封堵
网络与 child_process 模块、wall-clock 超时(SIGKILL)、内存上限、白名单式
env、一次性临时目录。

这是进程隔离而**不是沙箱**:子进程仍以调用者身份运行,理论上可读该用户可读的
文件。artifact 说明里应原样写明,不要用 "sandboxed" 一词带过。要跑不受信来源的
payload,须换成容器或 VM。
