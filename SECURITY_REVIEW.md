# Graph Agent MVP 安全审查

审查日期：2026-08-14

## 结论

未发现阻止 MVP 本地试用的 Critical 或 High 风险问题。评审曾识别的取消遗留、并发忙循环、skip 边配额绕过、NaN TTL 半提交、负 usage 绕过和结果/事件未绑定问题均已修复并加入回归测试。当前实现适合单进程受信任环境；生产部署仍需要持久化事务、租户隔离、密钥签名和人工审批。

## 已审查边界

- 模型 API 请求与密钥处理；
- 模型生成的工具名和 JSON 参数；
- Python 工具调用与异常回传；
- 子 Agent 派生、定向消息和跨代上下文提议；
- 会话记忆隔离；
- Token、轮次、工具调用数和时间预算；
- 事件日志中的敏感内容与防篡改能力；
- 包依赖和仓库内疑似密钥扫描。
- Controller 取消/并发状态机、全局图配额与预算账本；
- 结果完整绑定、checkpoint 严格 JSON 与恢复语义不变量。

## 已落实的防护

- 图操作为提议，不直接创建节点或边；
- `graph__` 整个命名空间保留，普通工具不能冒充图操作；
- 子 Agent 只能请求父节点已有工具，且代数、数量和累计预算受限；
- 远程模型端点强制 HTTPS，本机 loopback 允许 HTTP；
- 模型 HTTP 客户端禁用自动重定向，避免凭据被转发到其他主机；
- 自定义模型端点不会自动继承官方 `OPENAI_API_KEY`；
- API Key 在适配器 `repr` 中隐藏，且不会进入运行事件；
- 工具异常和节点异常返回脱敏信息；
- 同步工具在线程中执行，避免阻塞 Agent 事件循环；
- 事件只保存输入/输出 SHA-256 摘要和必要元数据；
- 会话记忆按 `node_id + session_id` 隔离；
- 核心包无第三方运行时依赖，开发依赖仅为测试和覆盖率工具。
- 同一 run 调度 single-flight，取消会把已 claim/ready 节点置为 cancelled 并释放全部预留；
- 结果摄取重新拒绝 bool/负数/超界 token、非整数 TTL、NaN/Inf 和超长/超量载荷；
- 终态 `result_hash` 绑定 output、usage、error 和全部 proposals，防止有效事件链被复用于篡改载荷；
- spawn/message/skip/dependency 全部受同一 max_edges 上限约束，执行依赖保持 DAG；
- Controller checkpoint 只使用 canonical JSON，拒绝重复键、NaN/Inf 和不可能的预算/拓扑状态；
- message/skip-context checkpoint 仅保存明文摘要，不持久化内容。

## 已知剩余风险

1. SHA-256 哈希链能检测篡改，但不能证明事件来源。跨主机部署应由 KMS/HMAC 或签名服务封签。
2. 协程超时不能回滚已经开始的网络、文件或数据库写入。高副作用工具必须使用幂等键、事务或补偿操作。
3. `InMemorySessionMemory` 不持久化且没有容量上限，只适合开发和短会话。生产环境需加密持久化、TTL 和配额。
4. Controller 当前只恢复经过语义校验的完整快照，尚未实现 SQLite 事务落盘和运行中 resume；进程崩溃恢复属于下一阶段。
5. “Untrusted context” 标签可以降低误用风险，但不能彻底消除提示注入。高风险工具仍需确定性参数验证和外部策略授权。
6. 兼容服务对 Chat Completions 细节的实现可能不同；生产部署需针对实际供应商做契约测试。
7. Node/Controller 的无密钥 SHA-256 链可被能重写整条记录的主体重新计算；跨信任域必须使用 HMAC/KMS 签名并外部锚定 chain head。
8. Node factory 当前同步运行在 Controller 临界区，只能注册快速、可信的 factory；慢或不可信构造器需要迁移到带超时的隔离执行边界。

## 发布门槛

- 单元/端到端测试通过；
- 分支覆盖率不低于 80%；
- 仓库扫描无真实密钥；
- 正式安装后 CLI 可离线运行；
- Controller 的审批记录不能替代工具边界的确定性授权；高风险工具仍需单独审批。
