/**
 * 代码生成评分器:在隔离的子进程中对隐藏单测运行模型生成的代码。
 *
 * ## 这是整个工程里唯一会执行不可信代码的组件
 *
 * 模型输出按定义是不可信输入(项目一贯立场,见 SECURITY_REVIEW.md)。执行它
 * 需要显式的隔离措施,且每一项都必须可解释:
 *
 *   1. **独立子进程**:`node --eval`,不在 harness 进程内 eval。崩溃、死循环、
 *      OOM 都限制在子进程内,不会带走整轮实验。
 *   2. **禁网**:子进程启动时把 `http`/`https`/`net`/`dns` 等模块的入口替换为抛错,
 *      并清空代理相关环境变量。注意这是**软隔离**:Node 没有进程级网络开关,
 *      一个足够刻意的 payload 仍可绕过(例如经 child_process)。故同时禁用
 *      `child_process`。真正的硬隔离需要容器或 seccomp——见下方「残余风险」。
 *   3. **wall-clock 超时**:到时 SIGKILL(非 SIGTERM,避免 payload 装 handler 赖着不走)。
 *   4. **内存上限**:`--max-old-space-size`,超限则子进程自行 OOM 退出。
 *   5. **文件系统**:cwd 设为一次性临时目录,实验结束即删;不向子进程传递
 *      任何凭据类环境变量(白名单式构造 env,而非从父进程继承后删除)。
 *
 * ## 残余风险(如实记录,不假装已消除)
 *
 * 上述是**进程级**隔离,不是沙箱。子进程仍以当前用户身份运行,理论上可读取该
 * 用户可读的文件。对「评测自己写的 agent 在公开 benchmark 上的表现」这一用途,
 * 风险可接受;若要跑不受信来源的 payload,必须换成容器或 VM。论文的 artifact
 * 说明里应当原样写明这一点,而不是声称 "sandboxed"。
 *
 * ## 为什么按通过比例给分
 *
 * 布尔通过/不通过会让「全错」与「差一个边界条件」不可分辨,消融实验据此损失
 * 大量信号。按通过的单测比例给分使部分正确可被区分。
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { score, type Score, type Scorer } from "../task.js";

/** 隔离参数;默认值偏保守。 */
export interface SandboxLimits {
  /** wall-clock 上限,毫秒。到时 SIGKILL。 */
  readonly timeoutMs: number;
  /** V8 老生代上限,MB。 */
  readonly memoryMb: number;
}

export const DEFAULT_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 5000,
  memoryMb: 256,
});

/** 一次沙箱执行的结果。 */
export interface SandboxOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** 因超时被杀。 */
  readonly timedOut: boolean;
  readonly exitCode: number | null;
}

/**
 * 注入到子进程最前面的序言:封堵网络与子进程派生。
 *
 * 用 `Module._load` 钩子而非逐个 require——后者无法覆盖 `node:` 前缀形式,
 * 也挡不住动态 import 之外的间接引用路径。
 */
const PRELUDE = `
const Module = require('node:module');
const BLOCKED = new Set([
  'http','https','net','dns','tls','dgram','child_process','cluster','worker_threads',
  'node:http','node:https','node:net','node:dns','node:tls','node:dgram',
  'node:child_process','node:cluster','node:worker_threads',
]);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (BLOCKED.has(request)) {
    throw new Error('module blocked in sandbox: ' + request);
  }
  return origLoad.call(this, request, parent, isMain);
};
globalThis.fetch = () => { throw new Error('network blocked in sandbox'); };
`;

/**
 * 在隔离子进程里执行一段脚本。
 *
 * env 以**白名单**方式构造:只给 PATH 与一个最小 HOME(指向临时目录)。
 * 不继承父进程 env——那会把 OPENAI_API_KEY 之类的凭据递给不可信代码。
 */
export async function runInSandbox(
  script: string,
  limits: SandboxLimits = DEFAULT_LIMITS,
): Promise<SandboxOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "ga-bench-"));
  const scriptPath = join(dir, "candidate.cjs");
  try {
    await writeFile(scriptPath, `${PRELUDE}\n${script}`, "utf8");
    return await new Promise<SandboxOutcome>((resolve) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${limits.memoryMb}`, scriptPath],
        {
          cwd: dir,
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: dir,
            NODE_ENV: "test",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // SIGKILL 而非 SIGTERM:payload 可能装了 SIGTERM handler 拖延退出。
        child.kill("SIGKILL");
      }, limits.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        // 限制缓冲,防止 payload 用海量输出撑爆 harness 内存。
        if (stdout.length < 64_000) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 64_000) stderr += chunk.toString("utf8");
      });
      child.on("error", (error: Error) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          stdout,
          stderr: `${stderr}\nspawn error: ${error.message}`,
          timedOut,
          exitCode: null,
        });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ ok: code === 0 && !timedOut, stdout, stderr, timedOut, exitCode: code });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 从模型输出中抽取代码。
 *
 * 优先取带语言标注的围栏块,其次任意围栏块,最后把整段当代码。取**最后**一个
 * 围栏块:agent 常先给草稿再给终稿。
 */
export function extractCode(output: string): string {
  const fenced = [...output.matchAll(/```(?:javascript|js|node)?\s*\n([\s\S]*?)```/g)];
  if (fenced.length > 0) {
    return fenced[fenced.length - 1]![1]!.trim();
  }
  return output.trim();
}

/** 一条隐藏单测:给定被测函数名,断言调用结果。 */
export interface UnitTest {
  /** 传给函数的实参(JSON 可序列化)。 */
  readonly args: readonly unknown[];
  /** 期望返回值(以 JSON 深相等比较)。 */
  readonly expected: unknown;
}

/**
 * 构造 codegen 评分器:把候选代码与隐藏单测拼成一个脚本,在沙箱里跑,
 * 按通过比例给分。
 *
 * 单测在子进程内逐条执行并打印 `PASS i` / `FAIL i`,父进程据此计数——不靠退出码,
 * 因为那只能表达全过/非全过。单条用例内的异常被捕获为该条失败,不中断其余用例。
 */
export function codegenScorer(input: {
  functionName: string;
  tests: readonly UnitTest[];
  limits?: SandboxLimits;
}): Scorer {
  const { functionName, tests } = input;
  if (tests.length === 0) {
    throw new Error("codegenScorer requires at least one test");
  }
  const limits = input.limits ?? DEFAULT_LIMITS;

  return async (output: string | null): Promise<Score> => {
    if (output === null || output.trim().length === 0) {
      return score(0, "no output");
    }
    const code = extractCode(output);
    if (code.length === 0) {
      return score(0, "no code found in output");
    }

    const harness = `
${code}

const __tests = ${JSON.stringify(tests)};
if (typeof ${functionName} !== 'function') {
  console.log('NOFUNC');
} else {
  for (let i = 0; i < __tests.length; i++) {
    try {
      const got = ${functionName}(...__tests[i].args);
      const ok = JSON.stringify(got) === JSON.stringify(__tests[i].expected);
      console.log((ok ? 'PASS ' : 'FAIL ') + i);
    } catch (e) {
      console.log('FAIL ' + i);
    }
  }
}
`;
    const outcome = await runInSandbox(harness, limits);
    if (outcome.timedOut) {
      return score(0, `timed out after ${limits.timeoutMs}ms`);
    }
    if (outcome.stdout.includes("NOFUNC")) {
      return score(0, `function ${functionName} not defined`);
    }
    let passed = 0;
    for (let i = 0; i < tests.length; i += 1) {
      if (outcome.stdout.includes(`PASS ${i}`)) {
        passed += 1;
      }
    }
    if (passed === 0 && !outcome.ok) {
      const reason = outcome.stderr.trim().split("\n")[0] ?? "execution failed";
      return score(0, `execution failed: ${reason.slice(0, 200)}`);
    }
    return score(passed / tests.length, `${passed}/${tests.length} tests passed`);
  };
}
