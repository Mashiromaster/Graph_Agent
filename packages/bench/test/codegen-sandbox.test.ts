/**
 * 沙箱的对抗性测试。
 *
 * 这是整个工程里唯一执行不可信代码的组件,因此隔离措施必须被**验证**而非假定。
 * 每个测试对应一类恶意或失控 payload,断言它被按预期限制住,且宿主环境未受影响。
 *
 * 注意本测试本身会在子进程里执行代码(这正是被测对象)。所有 payload 都是本文件
 * 内写定的良性探针——它们尝试越界,但不执行任何破坏性操作。
 */

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_LIMITS,
  codegenScorer,
  extractCode,
  runInSandbox,
} from "../src/scorers/codegen.js";

describe("runInSandbox basics", () => {
  it("runs a benign script and captures stdout", async () => {
    const outcome = await runInSandbox("console.log('hello')");
    expect(outcome.ok).toBe(true);
    expect(outcome.stdout.trim()).toBe("hello");
    expect(outcome.timedOut).toBe(false);
    expect(outcome.exitCode).toBe(0);
  });

  it("reports a non-zero exit for a throwing script", async () => {
    const outcome = await runInSandbox("throw new Error('boom')");
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain("boom");
  });

  it("cleans up its temp directory", async () => {
    // 捕获子进程看到的 cwd,再断言该目录事后已被删除。
    const outcome = await runInSandbox("console.log(process.cwd())");
    const dir = outcome.stdout.trim();
    expect(dir.length).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("sandbox containment", () => {
  it("kills an infinite loop at the wall-clock limit", async () => {
    const started = Date.now();
    const outcome = await runInSandbox("while (true) {}", {
      timeoutMs: 700,
      memoryMb: 128,
    });
    const elapsed = Date.now() - started;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
    // 确实在限额附近被杀,而不是跑满默认超时。
    expect(elapsed).toBeLessThan(5000);
  }, 15000);

  it("survives a payload that installs a SIGTERM handler (SIGKILL is used)", async () => {
    const outcome = await runInSandbox(
      "process.on('SIGTERM', () => {}); while (true) {}",
      { timeoutMs: 700, memoryMb: 128 },
    );
    expect(outcome.timedOut).toBe(true);
  }, 15000);

  it("blocks network modules", async () => {
    for (const mod of ["http", "https", "net", "node:http", "dns"]) {
      const outcome = await runInSandbox(`require('${mod}')`);
      expect(outcome.ok).toBe(false);
      expect(outcome.stderr).toContain("module blocked in sandbox");
    }
  }, 30000);

  it("blocks global fetch", async () => {
    const outcome = await runInSandbox(
      "fetch('https://example.com').then(() => console.log('REACHED'))",
    );
    expect(outcome.stdout).not.toContain("REACHED");
    expect(outcome.ok).toBe(false);
  });

  it("blocks child_process so the module hook cannot be bypassed by re-spawning", async () => {
    const outcome = await runInSandbox("require('child_process').execSync('echo escaped')");
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain("module blocked in sandbox");
    expect(outcome.stdout).not.toContain("escaped");
  });

  it("blocks worker_threads", async () => {
    const outcome = await runInSandbox("require('worker_threads')");
    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain("module blocked in sandbox");
  });

  it("does not leak parent credentials into the child env", async () => {
    // env 以白名单构造,故父进程里的敏感变量不可见。
    process.env["GA_BENCH_CANARY"] = "super-secret-token";
    try {
      const outcome = await runInSandbox(
        "console.log(JSON.stringify(Object.keys(process.env).sort()))",
      );
      expect(outcome.ok).toBe(true);
      const keys = JSON.parse(outcome.stdout.trim()) as string[];
      // 安全性断言:父进程的变量不可见。
      expect(keys).not.toContain("GA_BENCH_CANARY");
      // 白名单之外只容许平台自行注入的变量(macOS 会加
      // __CF_USER_TEXT_ENCODING),绝不容许任何凭据样式的键。
      const unexpected = keys.filter(
        (k) => !["HOME", "NODE_ENV", "PATH"].includes(k) && !k.startsWith("__CF_"),
      );
      expect(unexpected).toEqual([]);
      for (const key of keys) {
        expect(key).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
      }
    } finally {
      delete process.env["GA_BENCH_CANARY"];
    }
  });

  it("points HOME at the disposable directory, not the real home", async () => {
    const outcome = await runInSandbox("console.log(process.env.HOME)");
    expect(outcome.stdout).toContain(tmpdir().split("/").slice(-1)[0] ?? "tmp");
    expect(outcome.stdout.trim()).not.toBe(process.env["HOME"]);
  });

  it("caps captured stdout so a flooding payload cannot exhaust harness memory", async () => {
    const outcome = await runInSandbox(
      "for (let i = 0; i < 200000; i++) console.log('x'.repeat(100))",
      { timeoutMs: 4000, memoryMb: 128 },
    );
    expect(outcome.stdout.length).toBeLessThan(200_000);
  }, 15000);

  it("does not write into the repository working directory", async () => {
    const marker = join(process.cwd(), "ga-bench-escape-marker.txt");
    const outcome = await runInSandbox(
      "require('node:fs').writeFileSync('ga-bench-escape-marker.txt', 'x')",
    );
    // 相对路径写入落在子进程 cwd(临时目录),不在仓库里。
    expect(existsSync(marker)).toBe(false);
    expect(outcome.ok).toBe(true);
  });
});

describe("extractCode", () => {
  it("takes the last fenced block", () => {
    const output = [
      "First draft:",
      "```js",
      "function f() { return 1; }",
      "```",
      "Revised:",
      "```javascript",
      "function f() { return 2; }",
      "```",
    ].join("\n");
    expect(extractCode(output)).toBe("function f() { return 2; }");
  });

  it("handles an unlabelled fence", () => {
    expect(extractCode("```\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("falls back to the whole text", () => {
    expect(extractCode("function f() { return 1; }")).toBe("function f() { return 1; }");
  });
});

describe("codegenScorer", () => {
  const scorer = codegenScorer({
    functionName: "addTwo",
    tests: [
      { args: [1, 2], expected: 3 },
      { args: [0, 0], expected: 0 },
      { args: [-1, 1], expected: 0 },
      { args: [10, 5], expected: 15 },
    ],
  });

  it("gives full marks for a correct solution", async () => {
    const result = await scorer("```js\nfunction addTwo(a, b) { return a + b; }\n```");
    expect(result.value).toBe(1);
    expect(result.detail).toBe("4/4 tests passed");
  });

  it("gives partial credit so near-misses stay distinguishable from total failure", async () => {
    // 对负数处理错误:4 条里过 3 条。
    const result = await scorer(
      "```js\nfunction addTwo(a, b) { return Math.max(0, a) + b; }\n```",
    );
    expect(result.value).toBe(0.75);
    expect(result.detail).toBe("3/4 tests passed");
  });

  it("scores zero when the function is missing", async () => {
    const result = await scorer("```js\nfunction somethingElse() {}\n```");
    expect(result.value).toBe(0);
    expect(result.detail).toContain("not defined");
  });

  it("scores zero for a syntax error", async () => {
    const result = await scorer("```js\nfunction addTwo( { return\n```");
    expect(result.value).toBe(0);
    expect(result.detail).toContain("execution failed");
  });

  it("scores zero for empty or absent output", async () => {
    expect((await scorer(null)).detail).toBe("no output");
    expect((await scorer("   ")).detail).toBe("no output");
  });

  it("scores zero and recovers when the solution hangs", async () => {
    const fast = codegenScorer({
      functionName: "addTwo",
      tests: [{ args: [1, 2], expected: 3 }],
      limits: { timeoutMs: 700, memoryMb: 128 },
    });
    const result = await fast("```js\nfunction addTwo() { while(true){} }\n```");
    expect(result.value).toBe(0);
    expect(result.detail).toContain("timed out");
  }, 15000);

  it("isolates a per-test exception as a single failure", async () => {
    // 第一条用例抛错,其余正常 → 不中断整轮。
    const result = await scorer(
      "```js\nfunction addTwo(a,b){ if(a===1) throw new Error('x'); return a+b; }\n```",
    );
    expect(result.value).toBe(0.75);
  });

  it("is deterministic across repeats", async () => {
    const code = "```js\nfunction addTwo(a, b) { return a + b; }\n```";
    const a = await scorer(code);
    const b = await scorer(code);
    expect(a).toEqual(b);
  });

  it("rejects construction with no tests", () => {
    expect(() => codegenScorer({ functionName: "f", tests: [] })).toThrow();
  });

  it("uses conservative defaults", () => {
    expect(DEFAULT_LIMITS.timeoutMs).toBeLessThanOrEqual(10000);
    expect(DEFAULT_LIMITS.memoryMb).toBeLessThanOrEqual(512);
  });
});

describe("repository integrity after sandbox tests", () => {
  it("left no stray marker files and package.json is intact", async () => {
    expect(existsSync(join(process.cwd(), "ga-bench-escape-marker.txt"))).toBe(false);
    const pkg = await readFile(join(process.cwd(), "package.json"), "utf8");
    expect(JSON.parse(pkg)).toHaveProperty("name", "graph-agent");
  });
});
