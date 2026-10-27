# 中止的网格运行(38/255 格,不可用于统计)

失败率 62%:A2 全军覆没(15/15),A3 仅 1/7 成功。失败均为配置问题而非拓扑效应,
因此这批数据**不得进入论文统计**,仅作调试记录保留。

## 已定位并修复的四个配置错误

1. `maxTextLength: 16000` 默认值 < 实测产出 26k 字符 → validateResult 返回
   MALFORMED_RESULT → fail-closed 提交整笔预留。已改 64000。
2. `timeoutSeconds: 180` < 长产出实测耗时 → 超时转结构化 FAILED。已改 900。
3. 派生臂 root 只拿全局上限的 1/2,子节点再乘 budgetShare(0.2–0.33)→ 实得
   8000–13200,而每个子节点需约 10–14k output。3 个子节点全部饿死。
   已改 root 取 3/4,使 budgetShare=0.25 的子节点拿到 15000。
4. harness 给无效结果打分 → 出现 status=failed 配 q=0.875 的自相矛盾行。
   已改为仅当 root 被图采信(SUCCEEDED)时才评分。

## 未解决:withSeedMetadata 在实况多轮路径上使节点失败

隔离到:同一 spec 下 `bare` 与 `rec` 均成功派生 3 个子节点,而
`rec+seed`(RecordingModel 外再包 withSeedMetadata)立即 execution_error、
usage 全 0、spawns=0。离线用 fake transport 复现不出来,offline 两轮均正常。

尚未定位根因。下一步应在 AgentNode 的 _invokeTool / 异常路径上加诊断,
或暂时去掉种子标记(代价:同题不同种子共用 requestKey,重放时种子与响应
失去对应——见 models.ts 注释)。
