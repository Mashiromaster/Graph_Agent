# TS 重构:子项目 1「TS 基础设施 + 核心数据模型」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭好 monorepo TypeScript 骨架,把与运行时无关的纯数据模型、canonical JSON、SHA-256 事件链、fail-closed 守卫从 Python 迁到 `@graph-agent/core`,作为后续两层架构的共享地基。

**Architecture:** npm workspaces monorepo,单包 `packages/core`(包名 `@graph-agent/core`),`tsc` 严格模式构建 + `vitest` 测试。所有数据模型是 `readonly` interface,由工厂函数构造并 `Object.freeze`(对应 Python `frozen dataclass`);构造期用集中在 `guards.ts` 的 fail-closed 守卫做运行时校验。地基零业务依赖、零 IO。

**Tech Stack:** Node.js、TypeScript(strict)、tsc、vitest。无其它运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-20-ts-foundation-core-models-design.md`

## Global Constraints

- **命名**:TS 侧统一 camelCase(`nodeId`、`maxTurns`、`inputTokens`),不保留 Python snake_case。
- **不可变**:每个数据模型由工厂函数返回并 `Object.freeze`;interface 字段全部 `readonly`。
- **canonical JSON**:键排序、紧凑分隔符 `,` 与 `:`、保留非 ASCII(不转义)、遇 `NaN`/`Infinity` 抛错。
- **hash**:`sha256` 输出为 64 位小写十六进制;事件链 genesis = 64 个 `0`。
- **fail-closed 守卫**:整数须有界、非布尔、`Number.isInteger`;浮点须 `Number.isFinite`;权重/信任须落在 `[0,1]`;文本去空白后非空;非法输入抛 `TypeError`(类型/布尔冒充)或 `RangeError`(越界)。
- **不做**(YAGNI):不实现 Session/MessageStore/Runtime/Inbox/WorkLedger(子项目 2);不实现 Controller/super-step/Token 账本/checkpoint(子项目 3);不写 DeepSeek 适配器/HTTP/web_ui(子项目 4);不改动、不删除 Python `src/`;不引入除 TS/vitest 外的运行时依赖。
- **测试运行**:所有测试用 `npm test`(根 workspace)或 `npx vitest run <file>`;构建用 `npm run -w @graph-agent/core build`。
- **提交**:每个 task 末尾 commit,前缀 `feat:` / `test:` / `chore:` 视内容而定。

---

## 文件结构

**根目录(创建):**
- `package.json` — `private`、`type: module`、`workspaces: ["packages/*"]`、`scripts.test`/`build`。
- `tsconfig.base.json` — 严格模式基线,`extends` 供子包引用。
- `vitest.config.ts` — vitest 配置,include `packages/*/test`。
- `.gitignore` — 追加 `node_modules/`、`packages/*/dist/`(若已存在则合并)。

**`packages/core`(创建):**
- `package.json` — 包名 `@graph-agent/core`,`main`/`types` 指向 `dist/`,`build` 脚本 `tsc`。
- `tsconfig.json` — `extends: ../../tsconfig.base.json`,`outDir: dist`,`rootDir: src`。
- `src/hash.ts` — `canonicalJson(value)` + `sha256(text)` + `valueHash(value)`。
- `src/guards.ts` — fail-closed 校验守卫(整数/浮点/文本/sha256 字符串)。
- `src/identity.ts` — `AgentIdentity` interface + `createAgentIdentity(...)`。
- `src/budget.ts` — `NodeBudget`、`Usage` interface + 工厂 + `usageTotalTokens`、`addUsage`。
- `src/result.ts` — `NodeStatus`、`NodeError`、`ContextPacket`、`AgentInput`、`AgentResult` + 工厂。
- `src/proposals.ts` — `SpawnProposal`、`MessageProposal`、`SkipContextProposal` + 工厂。
- `src/events.ts` — `EventType`、`RunEvent`、`GENESIS_HASH`、`EventRecorder`、`verifyEventChain`、`resultBindingHash`。
- `src/index.ts` — 统一 re-export。
- `test/hash.test.ts`、`test/guards.test.ts`、`test/identity.test.ts`、`test/budget.test.ts`、`test/result.test.ts`、`test/proposals.test.ts`、`test/events.test.ts`、`test/smoke.test.ts`。

---

## Task 1: monorepo 骨架 + 空 core 包可构建

**Files:**
- Create: `package.json`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/test/smoke.test.ts`
- Modify: `.gitignore`(若存在则合并,否则创建)

**Interfaces:**
- Consumes: 无。
- Produces: 可 `import { PACKAGE_NAME } from "@graph-agent/core"`;`npm test` 与 `npm run -w @graph-agent/core build` 可跑通。

- [ ] **Step 1: 写根 `package.json`**

```json
{
  "name": "graph-agent",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run -ws --if-present build",
    "test": "vitest run",
    "typecheck": "npm run -ws --if-present typecheck"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "declaration": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 3: 写 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: 写 `packages/core/package.json`**

```json
{
  "name": "@graph-agent/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

- [ ] **Step 5: 写 `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 6: 写 `packages/core/src/index.ts`(临时占位,后续 task 逐步替换)**

```ts
export const PACKAGE_NAME = "@graph-agent/core";
```

- [ ] **Step 7: 写冒烟测试 `packages/core/test/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package smoke", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@graph-agent/core");
  });
});
```

- [ ] **Step 8: 合并/创建 `.gitignore`**

确保包含以下两行(若文件已存在,只追加缺失行,不删除现有内容):

```
node_modules/
packages/*/dist/
```

- [ ] **Step 9: 安装依赖并验证测试通过**

Run: `npm install && npm test`
Expected: vitest 报告 `smoke` 用例 PASS(1 passed)。

- [ ] **Step 10: 验证构建通过**

Run: `npm run -w @graph-agent/core build`
Expected: 无错误,生成 `packages/core/dist/index.js` 与 `index.d.ts`。

- [ ] **Step 11: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts packages/core .gitignore
git commit -m "chore: scaffold TS monorepo and empty @graph-agent/core package"
```

---

## Task 2: canonical JSON + sha256(hash.ts)

**Files:**
- Create: `packages/core/src/hash.ts`
- Test: `packages/core/test/hash.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `canonicalJson(value: unknown): string` — 键排序、分隔符 `,`/`:`、非 ASCII 不转义、遇非有限数抛 `RangeError`。
  - `sha256(text: string): string` — 64 位小写十六进制。
  - `valueHash(value: unknown): string` — `sha256(canonicalJson(value))`。

- [ ] **Step 1: 写失败测试 `packages/core/test/hash.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256, valueHash } from "../src/hash.js";

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("uses compact separators", () => {
    expect(canonicalJson([1, 2, { x: 3 }])).toBe('[1,2,{"x":3}]');
  });

  it("preserves non-ASCII characters without escaping", () => {
    expect(canonicalJson({ 名: "值" })).toBe('{"名":"值"}');
  });

  it("throws on NaN", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(RangeError);
  });

  it("throws on Infinity", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("sorts keys recursively in nested objects", () => {
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: 3 })).toBe(
      '{"a":3,"z":{"c":2,"d":1}}',
    );
  });
});

describe("sha256", () => {
  it("returns a 64-char lowercase hex string", () => {
    const digest = sha256("hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("valueHash", () => {
  it("is stable across key orderings", () => {
    expect(valueHash({ a: 1, b: 2 })).toBe(valueHash({ b: 2, a: 1 }));
  });

  it("changes when a value changes", () => {
    expect(valueHash({ a: 1 })).not.toBe(valueHash({ a: 2 }));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/hash.test.ts`
Expected: FAIL,报 `hash.js` 无法解析 / 导出不存在。

- [ ] **Step 3: 写实现 `packages/core/src/hash.ts`**

```ts
import { createHash } from "node:crypto";

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("canonicalJson does not allow NaN or Infinity");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`)
      .join(",");
    return `{${body}}`;
  }
  throw new TypeError(`canonicalJson cannot serialize ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function valueHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/hash.test.ts`
Expected: PASS(全部用例绿)。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/hash.ts packages/core/test/hash.test.ts
git commit -m "feat: add canonical JSON and sha256 hashing to core"
```

---

## Task 3: fail-closed 守卫(guards.ts)

**Files:**
- Create: `packages/core/src/guards.ts`
- Test: `packages/core/test/guards.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces(后续 task 的工厂函数用这些守卫校验字段):
  - `assertNonEmptyText(value: string, label: string): string` — 去空白后非空,否则 `RangeError`;非字符串 `TypeError`。
  - `assertBoundedInt(value: number, label: string, opts?: { min?: number; max?: number }): number` — `Number.isInteger`、非布尔、落在 `[min,max]`。
  - `assertUnitInterval(value: number, label: string): number` — `Number.isFinite` 且 `0 <= value <= 1`。
  - `assertBoolean(value: boolean, label: string): boolean` — 严格 `typeof === "boolean"`。
  - `assertSha256Hex(value: string, label: string): string` — 匹配 `/^[0-9a-f]{64}$/`。

- [ ] **Step 1: 写失败测试 `packages/core/test/guards.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  assertBoolean,
  assertBoundedInt,
  assertNonEmptyText,
  assertSha256Hex,
  assertUnitInterval,
} from "../src/guards.js";

describe("assertNonEmptyText", () => {
  it("returns the value when non-empty", () => {
    expect(assertNonEmptyText("hi", "label")).toBe("hi");
  });
  it("throws RangeError on whitespace-only", () => {
    expect(() => assertNonEmptyText("   ", "label")).toThrow(RangeError);
  });
  it("throws TypeError on non-string", () => {
    expect(() => assertNonEmptyText(1 as unknown as string, "label")).toThrow(
      TypeError,
    );
  });
});

describe("assertBoundedInt", () => {
  it("accepts an int within bounds", () => {
    expect(assertBoundedInt(5, "n", { min: 1, max: 10 })).toBe(5);
  });
  it("rejects booleans posing as ints", () => {
    expect(() =>
      assertBoundedInt(true as unknown as number, "n"),
    ).toThrow(TypeError);
  });
  it("rejects non-integers", () => {
    expect(() => assertBoundedInt(1.5, "n")).toThrow(TypeError);
  });
  it("rejects values below min", () => {
    expect(() => assertBoundedInt(0, "n", { min: 1 })).toThrow(RangeError);
  });
  it("rejects values above max", () => {
    expect(() => assertBoundedInt(11, "n", { max: 10 })).toThrow(RangeError);
  });
});

describe("assertUnitInterval", () => {
  it("accepts 0, 1, and midpoints", () => {
    expect(assertUnitInterval(0, "t")).toBe(0);
    expect(assertUnitInterval(1, "t")).toBe(1);
    expect(assertUnitInterval(0.5, "t")).toBe(0.5);
  });
  it("rejects out-of-range values", () => {
    expect(() => assertUnitInterval(1.1, "t")).toThrow(RangeError);
    expect(() => assertUnitInterval(-0.1, "t")).toThrow(RangeError);
  });
  it("rejects non-finite values", () => {
    expect(() => assertUnitInterval(Number.NaN, "t")).toThrow(RangeError);
  });
});

describe("assertBoolean", () => {
  it("accepts true and false", () => {
    expect(assertBoolean(true, "b")).toBe(true);
    expect(assertBoolean(false, "b")).toBe(false);
  });
  it("rejects non-booleans", () => {
    expect(() => assertBoolean(1 as unknown as boolean, "b")).toThrow(
      TypeError,
    );
  });
});

describe("assertSha256Hex", () => {
  it("accepts a 64-char lowercase hex string", () => {
    expect(assertSha256Hex("a".repeat(64), "h")).toBe("a".repeat(64));
  });
  it("rejects wrong length", () => {
    expect(() => assertSha256Hex("abc", "h")).toThrow(RangeError);
  });
  it("rejects uppercase hex", () => {
    expect(() => assertSha256Hex("A".repeat(64), "h")).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/guards.test.ts`
Expected: FAIL,`guards.js` 无法解析。

- [ ] **Step 3: 写实现 `packages/core/src/guards.ts`**

```ts
export function assertNonEmptyText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
  return value;
}

export function assertBoundedInt(
  value: number,
  label: string,
  opts: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || typeof value === "boolean") {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  const { min, max } = opts;
  if (min !== undefined && value < min) {
    throw new RangeError(`${label} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new RangeError(`${label} must be <= ${max}`);
  }
  return value;
}

export function assertUnitInterval(value: number, label: string): number {
  if (typeof value !== "number" || typeof value === "boolean") {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be within [0, 1]`);
  }
  return value;
}

export function assertBoolean(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

export function assertSha256Hex(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError(`${label} must be a 64-char lowercase hex string`);
  }
  return value;
}
```

注意:`assertBoundedInt`/`assertUnitInterval` 中 `typeof value === "boolean"` 分支在 `typeof value !== "number"` 之后看似冗余,但保留它使守卫对 `true/false` 经 `as unknown as number` 传入时也 fail-closed(`typeof true === "boolean"` 为真,直接抛),与测试一致。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/guards.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/guards.ts packages/core/test/guards.test.ts
git commit -m "feat: add fail-closed validation guards to core"
```

---

## Task 4: AgentIdentity(identity.ts)

**Files:**
- Create: `packages/core/src/identity.ts`
- Test: `packages/core/test/identity.test.ts`

**Interfaces:**
- Consumes: `assertNonEmptyText`、`assertBoundedInt`、`assertUnitInterval`(guards.ts)。
- Produces:
  - `interface AgentIdentity { readonly nodeId: string; readonly name: string; readonly role: string; readonly generation: number; readonly parentNodeId: string | null; readonly trustScore: number; }`
  - `createAgentIdentity(input: { nodeId: string; name: string; role: string; generation?: number; parentNodeId?: string | null; trustScore?: number }): AgentIdentity` — 默认 `generation=0`、`parentNodeId=null`、`trustScore=1`;返回 `Object.freeze` 后的对象。

- [ ] **Step 1: 写失败测试 `packages/core/test/identity.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { createAgentIdentity } from "../src/identity.js";

describe("createAgentIdentity", () => {
  it("applies defaults", () => {
    const id = createAgentIdentity({ nodeId: "n1", name: "root", role: "orchestrator" });
    expect(id.generation).toBe(0);
    expect(id.parentNodeId).toBeNull();
    expect(id.trustScore).toBe(1);
  });

  it("freezes the returned object", () => {
    const id = createAgentIdentity({ nodeId: "n1", name: "root", role: "r" });
    expect(Object.isFrozen(id)).toBe(true);
    expect(() => {
      (id as { nodeId: string }).nodeId = "x";
    }).toThrow();
  });

  it("rejects empty nodeId", () => {
    expect(() =>
      createAgentIdentity({ nodeId: "  ", name: "n", role: "r" }),
    ).toThrow(RangeError);
  });

  it("rejects negative generation", () => {
    expect(() =>
      createAgentIdentity({ nodeId: "n1", name: "n", role: "r", generation: -1 }),
    ).toThrow(RangeError);
  });

  it("rejects trustScore outside [0,1]", () => {
    expect(() =>
      createAgentIdentity({ nodeId: "n1", name: "n", role: "r", trustScore: 1.5 }),
    ).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/identity.test.ts`
Expected: FAIL,`identity.js` 无法解析。

- [ ] **Step 3: 写实现 `packages/core/src/identity.ts`**

```ts
import { assertBoundedInt, assertNonEmptyText, assertUnitInterval } from "./guards.js";

export interface AgentIdentity {
  readonly nodeId: string;
  readonly name: string;
  readonly role: string;
  readonly generation: number;
  readonly parentNodeId: string | null;
  readonly trustScore: number;
}

export function createAgentIdentity(input: {
  nodeId: string;
  name: string;
  role: string;
  generation?: number;
  parentNodeId?: string | null;
  trustScore?: number;
}): AgentIdentity {
  const generation = input.generation ?? 0;
  const trustScore = input.trustScore ?? 1;
  const parentNodeId = input.parentNodeId ?? null;
  return Object.freeze({
    nodeId: assertNonEmptyText(input.nodeId, "nodeId"),
    name: assertNonEmptyText(input.name, "name"),
    role: assertNonEmptyText(input.role, "role"),
    generation: assertBoundedInt(generation, "generation", { min: 0 }),
    parentNodeId:
      parentNodeId === null ? null : assertNonEmptyText(parentNodeId, "parentNodeId"),
    trustScore: assertUnitInterval(trustScore, "trustScore"),
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/identity.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/identity.ts packages/core/test/identity.test.ts
git commit -m "feat: add AgentIdentity model to core"
```

---

## Task 5: NodeBudget + Usage(budget.ts)

**Files:**
- Modify: `packages/core/src/guards.ts`(追加 `assertFinitePositive`)
- Create: `packages/core/src/budget.ts`
- Test: `packages/core/test/budget.test.ts`

**Interfaces:**
- Consumes: `assertBoundedInt`(guards.ts);本 task 新增 `assertFinitePositive` 到 guards.ts。
- Produces:
  - `assertFinitePositive(value: number, label: string): number` — `Number.isFinite` 且 `> 0`;非数/布尔 `TypeError`,越界 `RangeError`。
  - `interface NodeBudget { readonly maxTurns: number; readonly maxToolCalls: number; readonly maxTotalTokens: number; readonly timeoutSeconds: number; }`
  - `createNodeBudget(input?): NodeBudget` — 默认 `8 / 16 / 32000 / 120`;`maxTurns>=1`、`maxToolCalls>=0`、`maxTotalTokens>=1`、`timeoutSeconds>0` 且有限。
  - `interface Usage { readonly inputTokens: number; readonly outputTokens: number; }`
  - `createUsage(input?): Usage` — 默认 `0/0`,非负整数。
  - `usageTotalTokens(usage: Usage): number`
  - `addUsage(a: Usage, b: Usage): Usage`

- [ ] **Step 1: 在 `guards.ts` 追加 `assertFinitePositive`**

在 `packages/core/src/guards.ts` 末尾追加:

```ts
export function assertFinitePositive(value: number, label: string): number {
  if (typeof value !== "number" || typeof value === "boolean") {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive finite number`);
  }
  return value;
}
```

- [ ] **Step 2: 写失败测试 `packages/core/test/budget.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { addUsage, createNodeBudget, createUsage, usageTotalTokens } from "../src/budget.js";

describe("createNodeBudget", () => {
  it("applies defaults", () => {
    const b = createNodeBudget();
    expect(b).toEqual({
      maxTurns: 8,
      maxToolCalls: 16,
      maxTotalTokens: 32000,
      timeoutSeconds: 120,
    });
    expect(Object.isFrozen(b)).toBe(true);
  });

  it("rejects maxTurns below 1", () => {
    expect(() => createNodeBudget({ maxTurns: 0 })).toThrow(RangeError);
  });

  it("rejects negative maxToolCalls", () => {
    expect(() => createNodeBudget({ maxToolCalls: -1 })).toThrow(RangeError);
  });

  it("rejects non-positive timeoutSeconds", () => {
    expect(() => createNodeBudget({ timeoutSeconds: 0 })).toThrow(RangeError);
  });
});

describe("Usage", () => {
  it("defaults to zero and freezes", () => {
    const u = createUsage();
    expect(u).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.isFrozen(u)).toBe(true);
  });

  it("rejects negative tokens", () => {
    expect(() => createUsage({ inputTokens: -1 })).toThrow(RangeError);
  });

  it("computes total tokens", () => {
    expect(usageTotalTokens(createUsage({ inputTokens: 3, outputTokens: 4 }))).toBe(7);
  });

  it("adds two usages", () => {
    const sum = addUsage(
      createUsage({ inputTokens: 1, outputTokens: 2 }),
      createUsage({ inputTokens: 3, outputTokens: 4 }),
    );
    expect(sum).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(Object.isFrozen(sum)).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run packages/core/test/budget.test.ts`
Expected: FAIL,`budget.js` 无法解析。

- [ ] **Step 4: 写实现 `packages/core/src/budget.ts`**

```ts
import { assertBoundedInt, assertFinitePositive } from "./guards.js";

export interface NodeBudget {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly timeoutSeconds: number;
}

export function createNodeBudget(
  input: {
    maxTurns?: number;
    maxToolCalls?: number;
    maxTotalTokens?: number;
    timeoutSeconds?: number;
  } = {},
): NodeBudget {
  return Object.freeze({
    maxTurns: assertBoundedInt(input.maxTurns ?? 8, "maxTurns", { min: 1 }),
    maxToolCalls: assertBoundedInt(input.maxToolCalls ?? 16, "maxToolCalls", { min: 0 }),
    maxTotalTokens: assertBoundedInt(input.maxTotalTokens ?? 32000, "maxTotalTokens", {
      min: 1,
    }),
    timeoutSeconds: assertFinitePositive(input.timeoutSeconds ?? 120, "timeoutSeconds"),
  });
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function createUsage(
  input: { inputTokens?: number; outputTokens?: number } = {},
): Usage {
  return Object.freeze({
    inputTokens: assertBoundedInt(input.inputTokens ?? 0, "inputTokens", { min: 0 }),
    outputTokens: assertBoundedInt(input.outputTokens ?? 0, "outputTokens", { min: 0 }),
  });
}

export function usageTotalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return createUsage({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run packages/core/test/budget.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/guards.ts packages/core/src/budget.ts packages/core/test/budget.test.ts
git commit -m "feat: add NodeBudget and Usage models to core"
```

---

## Task 6: 结果模型(result.ts)

**Files:**
- Create: `packages/core/src/result.ts`
- Test: `packages/core/test/result.test.ts`

**Interfaces:**
- Consumes: `assertNonEmptyText`、`assertUnitInterval`、`assertBoolean`(guards.ts);`Usage`(budget.ts);`SpawnProposal`/`MessageProposal`/`SkipContextProposal`(proposals.ts,Task 7,`import type`);`RunEvent`(events.ts,Task 8,`import type`)。
- Produces:
  - `const NodeStatus`(冻结常量对象:`.COMPLETED="completed"`、`.FAILED="failed"`)+ `type NodeStatus`。
  - `interface NodeError { readonly code: string; readonly message: string; readonly retryable: boolean; }` + `createNodeError`(默认 `retryable=false`)。
  - `interface ContextPacket { readonly sourceNodeId: string; readonly content: string; readonly trust: number; readonly edgeType: string; }` + `createContextPacket`(默认 `trust=1`、`edgeType="message"`)。
  - `interface AgentInput { readonly task: string; readonly context: readonly ContextPacket[]; readonly sessionId: string | null; readonly metadata: Readonly<Record<string, unknown>>; }` + `createAgentInput`。
  - `interface AgentResult { readonly nodeId; readonly status: NodeStatus; readonly output: string | null; readonly usage: Usage; readonly events: readonly RunEvent[]; readonly spawnProposals: readonly SpawnProposal[]; readonly messageProposals: readonly MessageProposal[]; readonly skipContextProposals: readonly SkipContextProposal[]; readonly error: NodeError | null; }` + `createAgentResult`。

> **依赖顺序说明**:result.ts 在类型上依赖 proposals.ts(Task 7)与 events.ts(Task 8),用 `import type` 引用——类型擦除后不产生运行时依赖。故 vitest(esbuild 擦除 type-only import)在本 task 即可绿;`tsc` 全绿在 Task 9(proposals/events 都已存在后)统一验证。本 task 的测试只覆盖不依赖 proposals/events 的工厂;`AgentResult` 的端到端组装测试放在 Task 9 的 smoke。

- [ ] **Step 1: 写失败测试 `packages/core/test/result.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  NodeStatus,
  createAgentInput,
  createContextPacket,
  createNodeError,
} from "../src/result.js";

describe("NodeStatus", () => {
  it("exposes completed and failed", () => {
    expect(NodeStatus.COMPLETED).toBe("completed");
    expect(NodeStatus.FAILED).toBe("failed");
  });
});

describe("createNodeError", () => {
  it("defaults retryable to false and freezes", () => {
    const e = createNodeError({ code: "E", message: "boom" });
    expect(e).toEqual({ code: "E", message: "boom", retryable: false });
    expect(Object.isFrozen(e)).toBe(true);
  });
  it("rejects empty code", () => {
    expect(() => createNodeError({ code: " ", message: "m" })).toThrow(RangeError);
  });
});

describe("createContextPacket", () => {
  it("applies defaults and freezes", () => {
    const c = createContextPacket({ sourceNodeId: "n1", content: "hi" });
    expect(c).toEqual({ sourceNodeId: "n1", content: "hi", trust: 1, edgeType: "message" });
    expect(Object.isFrozen(c)).toBe(true);
  });
  it("rejects trust outside [0,1]", () => {
    expect(() =>
      createContextPacket({ sourceNodeId: "n1", content: "hi", trust: 2 }),
    ).toThrow(RangeError);
  });
});

describe("createAgentInput", () => {
  it("defaults context/sessionId/metadata and freezes", () => {
    const i = createAgentInput({ task: "do it" });
    expect(i.task).toBe("do it");
    expect(i.context).toEqual([]);
    expect(i.sessionId).toBeNull();
    expect(i.metadata).toEqual({});
    expect(Object.isFrozen(i)).toBe(true);
    expect(Object.isFrozen(i.context)).toBe(true);
  });
  it("rejects empty task", () => {
    expect(() => createAgentInput({ task: "  " })).toThrow(RangeError);
  });
  it("rejects empty sessionId when provided", () => {
    expect(() => createAgentInput({ task: "t", sessionId: " " })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/result.test.ts`
Expected: FAIL,`result.js` 无法解析。

- [ ] **Step 3: 写实现 `packages/core/src/result.ts`**

```ts
import type { Usage } from "./budget.js";
import { assertBoolean, assertNonEmptyText, assertUnitInterval } from "./guards.js";
import type { MessageProposal, SkipContextProposal, SpawnProposal } from "./proposals.js";
import type { RunEvent } from "./events.js";

export const NodeStatus = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
} as const);

export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

export interface NodeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function createNodeError(input: {
  code: string;
  message: string;
  retryable?: boolean;
}): NodeError {
  return Object.freeze({
    code: assertNonEmptyText(input.code, "code"),
    message: assertNonEmptyText(input.message, "message"),
    retryable: assertBoolean(input.retryable ?? false, "retryable"),
  });
}

export interface ContextPacket {
  readonly sourceNodeId: string;
  readonly content: string;
  readonly trust: number;
  readonly edgeType: string;
}

export function createContextPacket(input: {
  sourceNodeId: string;
  content: string;
  trust?: number;
  edgeType?: string;
}): ContextPacket {
  return Object.freeze({
    sourceNodeId: assertNonEmptyText(input.sourceNodeId, "sourceNodeId"),
    content: assertNonEmptyText(input.content, "content"),
    trust: assertUnitInterval(input.trust ?? 1, "trust"),
    edgeType: assertNonEmptyText(input.edgeType ?? "message", "edgeType"),
  });
}

export interface AgentInput {
  readonly task: string;
  readonly context: readonly ContextPacket[];
  readonly sessionId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function createAgentInput(input: {
  task: string;
  context?: readonly ContextPacket[];
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
}): AgentInput {
  const sessionId = input.sessionId ?? null;
  return Object.freeze({
    task: assertNonEmptyText(input.task, "task"),
    context: Object.freeze([...(input.context ?? [])]),
    sessionId: sessionId === null ? null : assertNonEmptyText(sessionId, "sessionId"),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export interface AgentResult {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly output: string | null;
  readonly usage: Usage;
  readonly events: readonly RunEvent[];
  readonly spawnProposals: readonly SpawnProposal[];
  readonly messageProposals: readonly MessageProposal[];
  readonly skipContextProposals: readonly SkipContextProposal[];
  readonly error: NodeError | null;
}

export function createAgentResult(input: {
  nodeId: string;
  status: NodeStatus;
  output: string | null;
  usage: Usage;
  events: readonly RunEvent[];
  spawnProposals?: readonly SpawnProposal[];
  messageProposals?: readonly MessageProposal[];
  skipContextProposals?: readonly SkipContextProposal[];
  error?: NodeError | null;
}): AgentResult {
  return Object.freeze({
    nodeId: assertNonEmptyText(input.nodeId, "nodeId"),
    status: input.status,
    output: input.output,
    usage: input.usage,
    events: Object.freeze([...input.events]),
    spawnProposals: Object.freeze([...(input.spawnProposals ?? [])]),
    messageProposals: Object.freeze([...(input.messageProposals ?? [])]),
    skipContextProposals: Object.freeze([...(input.skipContextProposals ?? [])]),
    error: input.error ?? null,
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/result.test.ts`
Expected: PASS。(`result.ts` 顶部对 `./proposals.js` / `./events.js` 用 `import type`,vitest 的 esbuild 擦除后不实际加载这两个尚不存在的模块,故测试可绿;`tsc` 全绿在 Task 9 验证。)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/result.ts packages/core/test/result.test.ts
git commit -m "feat: add result models (status, error, context, input, result) to core"
```

---

## Task 7: 提议模型(proposals.ts)

**Files:**
- Create: `packages/core/src/proposals.ts`
- Test: `packages/core/test/proposals.test.ts`

**Interfaces:**
- Consumes: `assertNonEmptyText`、`assertBoundedInt`、`assertUnitInterval`(guards.ts)。
- Produces:
  - `interface SpawnProposal { readonly proposalId: string; readonly parentNodeId: string; readonly generation: number; readonly role: string; readonly objective: string; readonly instructions: string; readonly toolNames: readonly string[]; readonly priority: number; readonly budgetShare: number; }` + `createSpawnProposal`(默认 `toolNames=[]`、`priority=0.5`、`budgetShare=0.25`)。
  - `interface MessageProposal { readonly proposalId: string; readonly sourceNodeId: string; readonly targetNodeId: string; readonly content: string; readonly priority: number; readonly ttlSeconds: number; }` + `createMessageProposal`(默认 `priority=0.5`、`ttlSeconds=300`)。
  - `interface SkipContextProposal { readonly proposalId: string; readonly requesterNodeId: string; readonly sourceNodeId: string; readonly reason: string; readonly contextGate: number; }` + `createSkipContextProposal`(默认 `contextGate=0.5`)。

- [ ] **Step 1: 写失败测试 `packages/core/test/proposals.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  createMessageProposal,
  createSkipContextProposal,
  createSpawnProposal,
} from "../src/proposals.js";

describe("createSpawnProposal", () => {
  it("applies defaults and freezes", () => {
    const p = createSpawnProposal({
      proposalId: "p1",
      parentNodeId: "n0",
      generation: 1,
      role: "researcher",
      objective: "find X",
      instructions: "do the research",
    });
    expect(p.toolNames).toEqual([]);
    expect(p.priority).toBe(0.5);
    expect(p.budgetShare).toBe(0.25);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.toolNames)).toBe(true);
  });
  it("rejects generation below 0", () => {
    expect(() =>
      createSpawnProposal({
        proposalId: "p1",
        parentNodeId: "n0",
        generation: -1,
        role: "r",
        objective: "o",
        instructions: "i",
      }),
    ).toThrow(RangeError);
  });
  it("rejects budgetShare outside [0,1]", () => {
    expect(() =>
      createSpawnProposal({
        proposalId: "p1",
        parentNodeId: "n0",
        generation: 1,
        role: "r",
        objective: "o",
        instructions: "i",
        budgetShare: 1.5,
      }),
    ).toThrow(RangeError);
  });
});

describe("createMessageProposal", () => {
  it("applies defaults and freezes", () => {
    const p = createMessageProposal({
      proposalId: "p2",
      sourceNodeId: "a",
      targetNodeId: "b",
      content: "hi",
    });
    expect(p.priority).toBe(0.5);
    expect(p.ttlSeconds).toBe(300);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it("rejects negative ttlSeconds", () => {
    expect(() =>
      createMessageProposal({
        proposalId: "p2",
        sourceNodeId: "a",
        targetNodeId: "b",
        content: "hi",
        ttlSeconds: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe("createSkipContextProposal", () => {
  it("applies defaults and freezes", () => {
    const p = createSkipContextProposal({
      proposalId: "p3",
      requesterNodeId: "a",
      sourceNodeId: "b",
      reason: "not relevant",
    });
    expect(p.contextGate).toBe(0.5);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it("rejects contextGate outside [0,1]", () => {
    expect(() =>
      createSkipContextProposal({
        proposalId: "p3",
        requesterNodeId: "a",
        sourceNodeId: "b",
        reason: "r",
        contextGate: -0.1,
      }),
    ).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/proposals.test.ts`
Expected: FAIL,`proposals.js` 无法解析。

- [ ] **Step 3: 写实现 `packages/core/src/proposals.ts`**

```ts
import { assertBoundedInt, assertNonEmptyText, assertUnitInterval } from "./guards.js";

export interface SpawnProposal {
  readonly proposalId: string;
  readonly parentNodeId: string;
  readonly generation: number;
  readonly role: string;
  readonly objective: string;
  readonly instructions: string;
  readonly toolNames: readonly string[];
  readonly priority: number;
  readonly budgetShare: number;
}

export function createSpawnProposal(input: {
  proposalId: string;
  parentNodeId: string;
  generation: number;
  role: string;
  objective: string;
  instructions: string;
  toolNames?: readonly string[];
  priority?: number;
  budgetShare?: number;
}): SpawnProposal {
  const toolNames = (input.toolNames ?? []).map((name, index) =>
    assertNonEmptyText(name, `toolNames[${index}]`),
  );
  return Object.freeze({
    proposalId: assertNonEmptyText(input.proposalId, "proposalId"),
    parentNodeId: assertNonEmptyText(input.parentNodeId, "parentNodeId"),
    generation: assertBoundedInt(input.generation, "generation", { min: 0 }),
    role: assertNonEmptyText(input.role, "role"),
    objective: assertNonEmptyText(input.objective, "objective"),
    instructions: assertNonEmptyText(input.instructions, "instructions"),
    toolNames: Object.freeze(toolNames),
    priority: assertUnitInterval(input.priority ?? 0.5, "priority"),
    budgetShare: assertUnitInterval(input.budgetShare ?? 0.25, "budgetShare"),
  });
}

export interface MessageProposal {
  readonly proposalId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly content: string;
  readonly priority: number;
  readonly ttlSeconds: number;
}

export function createMessageProposal(input: {
  proposalId: string;
  sourceNodeId: string;
  targetNodeId: string;
  content: string;
  priority?: number;
  ttlSeconds?: number;
}): MessageProposal {
  return Object.freeze({
    proposalId: assertNonEmptyText(input.proposalId, "proposalId"),
    sourceNodeId: assertNonEmptyText(input.sourceNodeId, "sourceNodeId"),
    targetNodeId: assertNonEmptyText(input.targetNodeId, "targetNodeId"),
    content: assertNonEmptyText(input.content, "content"),
    priority: assertUnitInterval(input.priority ?? 0.5, "priority"),
    ttlSeconds: assertBoundedInt(input.ttlSeconds ?? 300, "ttlSeconds", { min: 0 }),
  });
}

export interface SkipContextProposal {
  readonly proposalId: string;
  readonly requesterNodeId: string;
  readonly sourceNodeId: string;
  readonly reason: string;
  readonly contextGate: number;
}

export function createSkipContextProposal(input: {
  proposalId: string;
  requesterNodeId: string;
  sourceNodeId: string;
  reason: string;
  contextGate?: number;
}): SkipContextProposal {
  return Object.freeze({
    proposalId: assertNonEmptyText(input.proposalId, "proposalId"),
    requesterNodeId: assertNonEmptyText(input.requesterNodeId, "requesterNodeId"),
    sourceNodeId: assertNonEmptyText(input.sourceNodeId, "sourceNodeId"),
    reason: assertNonEmptyText(input.reason, "reason"),
    contextGate: assertUnitInterval(input.contextGate ?? 0.5, "contextGate"),
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/proposals.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/proposals.ts packages/core/test/proposals.test.ts
git commit -m "feat: add spawn/message/skip-context proposal models to core"
```

---

## Task 8: 事件链(events.ts)

**Files:**
- Create: `packages/core/src/events.ts`
- Test: `packages/core/test/events.test.ts`

**Interfaces:**
- Consumes: `canonicalJson`、`sha256`、`valueHash`(hash.ts)。
- Produces:
  - `const EventType`(冻结常量对象:`NODE_STARTED="node_started"`/`NODE_COMPLETED="node_completed"`/`NODE_FAILED="node_failed"`/`BUDGET_EXCEEDED="budget_exceeded"`)+ `type EventType`。
  - `const GENESIS_HASH = "0".repeat(64)`。
  - `interface RunEvent { readonly sequence: number; readonly timestamp: number; readonly nodeId: string; readonly type: EventType; readonly inputHash: string; readonly outputHash: string; readonly metadataJson: string; readonly previousHash: string; readonly eventHash: string; }`。
  - `class EventRecorder`(构造 `new EventRecorder(nodeId, clock?)`;`clock` 默认 `() => Date.now()`,供测试注入确定性时间);方法 `record({ type, inputValue?, outputValue?, metadata? }): RunEvent`;getter `events: readonly RunEvent[]`。
  - `verifyEventChain(events: readonly RunEvent[]): boolean`。
  - `resultBindingHash(input: { nodeId; status; output; inputTokens; outputTokens; spawnProposals?; messageProposals?; skipContextProposals?; error? }): string`。
- 事件哈希算法(与 spec §3.5 一致,取代 Python 的 `|`-join + `repr(timestamp)`):`eventHash = sha256(canonicalJson({ sequence, timestamp, nodeId, type, inputHash, outputHash, metadataJson, previousHash }))`。

- [ ] **Step 1: 写失败测试 `packages/core/test/events.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  GENESIS_HASH,
  resultBindingHash,
  verifyEventChain,
} from "../src/events.js";

function fixedClock(): () => number {
  let t = 1000;
  return () => (t += 1);
}

describe("EventRecorder", () => {
  it("chains events from genesis", () => {
    const rec = new EventRecorder("n1", fixedClock());
    const first = rec.record({ type: EventType.NODE_STARTED });
    const second = rec.record({ type: EventType.NODE_COMPLETED, outputValue: "done" });
    expect(first.sequence).toBe(0);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.sequence).toBe(1);
    expect(second.previousHash).toBe(first.eventHash);
    expect(rec.events).toHaveLength(2);
    expect(Object.isFrozen(rec.events[0])).toBe(true);
  });

  it("produces a valid chain", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED });
    expect(verifyEventChain(rec.events)).toBe(true);
  });
});

describe("verifyEventChain", () => {
  it("accepts an empty chain", () => {
    expect(verifyEventChain([])).toBe(true);
  });

  it("detects a tampered field", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    const events = [...rec.events];
    events[0] = { ...events[0]!, nodeId: "evil" };
    expect(verifyEventChain(events)).toBe(false);
  });

  it("detects a broken link", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED });
    const events = [...rec.events];
    events[1] = { ...events[1]!, previousHash: GENESIS_HASH };
    expect(verifyEventChain(events)).toBe(false);
  });

  it("detects a forged eventHash", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    const events = [...rec.events];
    events[0] = { ...events[0]!, eventHash: "f".repeat(64) };
    expect(verifyEventChain(events)).toBe(false);
  });

  it("detects an out-of-order sequence", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED });
    expect(verifyEventChain([rec.events[1]!, rec.events[0]!])).toBe(false);
  });
});

describe("resultBindingHash", () => {
  it("is stable for identical inputs", () => {
    const base = {
      nodeId: "n1",
      status: "completed",
      output: "ok",
      inputTokens: 1,
      outputTokens: 2,
    };
    expect(resultBindingHash(base)).toBe(resultBindingHash({ ...base }));
  });

  it("changes when output changes", () => {
    const base = {
      nodeId: "n1",
      status: "completed",
      output: "ok",
      inputTokens: 1,
      outputTokens: 2,
    };
    expect(resultBindingHash(base)).not.toBe(
      resultBindingHash({ ...base, output: "different" }),
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/events.test.ts`
Expected: FAIL,`events.js` 无法解析。

- [ ] **Step 3: 写实现 `packages/core/src/events.ts`**

```ts
import { canonicalJson, sha256, valueHash } from "./hash.js";

export const EventType = Object.freeze({
  NODE_STARTED: "node_started",
  NODE_COMPLETED: "node_completed",
  NODE_FAILED: "node_failed",
  BUDGET_EXCEEDED: "budget_exceeded",
} as const);

export type EventType = (typeof EventType)[keyof typeof EventType];

export const GENESIS_HASH = "0".repeat(64);

export interface RunEvent {
  readonly sequence: number;
  readonly timestamp: number;
  readonly nodeId: string;
  readonly type: EventType;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly metadataJson: string;
  readonly previousHash: string;
  readonly eventHash: string;
}

function computeEventHash(fields: {
  sequence: number;
  timestamp: number;
  nodeId: string;
  type: EventType;
  inputHash: string;
  outputHash: string;
  metadataJson: string;
  previousHash: string;
}): string {
  return sha256(canonicalJson(fields));
}

export class EventRecorder {
  private readonly nodeId: string;
  private readonly clock: () => number;
  private readonly log: RunEvent[] = [];

  constructor(nodeId: string, clock: () => number = () => Date.now()) {
    this.nodeId = nodeId;
    this.clock = clock;
  }

  get events(): readonly RunEvent[] {
    return Object.freeze([...this.log]);
  }

  record(input: {
    type: EventType;
    inputValue?: unknown;
    outputValue?: unknown;
    metadata?: Record<string, unknown>;
  }): RunEvent {
    const sequence = this.log.length;
    const timestamp = this.clock();
    const previousHash =
      this.log.length > 0 ? this.log[this.log.length - 1]!.eventHash : GENESIS_HASH;
    const inputHash = valueHash(input.inputValue ?? null);
    const outputHash = valueHash(input.outputValue ?? null);
    const metadataJson = canonicalJson(input.metadata ?? {});
    const fields = {
      sequence,
      timestamp,
      nodeId: this.nodeId,
      type: input.type,
      inputHash,
      outputHash,
      metadataJson,
      previousHash,
    };
    const event: RunEvent = Object.freeze({
      ...fields,
      eventHash: computeEventHash(fields),
    });
    this.log.push(event);
    return event;
  }
}

export function verifyEventChain(events: readonly RunEvent[]): boolean {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence !== index || event.previousHash !== previousHash) {
      return false;
    }
    const recalculated = computeEventHash({
      sequence: event.sequence,
      timestamp: event.timestamp,
      nodeId: event.nodeId,
      type: event.type,
      inputHash: event.inputHash,
      outputHash: event.outputHash,
      metadataJson: event.metadataJson,
      previousHash: event.previousHash,
    });
    if (recalculated !== event.eventHash) {
      return false;
    }
    previousHash = event.eventHash;
  }
  return true;
}

export function resultBindingHash(input: {
  nodeId: string;
  status: string;
  output: string | null;
  inputTokens: number;
  outputTokens: number;
  spawnProposals?: readonly unknown[];
  messageProposals?: readonly unknown[];
  skipContextProposals?: readonly unknown[];
  error?: unknown;
}): string {
  return valueHash({
    error: input.error ?? null,
    inputTokens: input.inputTokens,
    messageProposals: [...(input.messageProposals ?? [])],
    nodeId: input.nodeId,
    output: input.output,
    outputTokens: input.outputTokens,
    skipContextProposals: [...(input.skipContextProposals ?? [])],
    spawnProposals: [...(input.spawnProposals ?? [])],
    status: input.status,
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run packages/core/test/events.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/test/events.test.ts
git commit -m "feat: add SHA-256 event chain and result binding to core"
```

---

## Task 9: 统一导出(index.ts)+ 全量构建/测试验证

**Files:**
- Modify: `packages/core/src/index.ts`(替换 Task 1 的临时占位)
- Modify: `packages/core/test/smoke.test.ts`(改为验证聚合导出与端到端组装)

**Interfaces:**
- Consumes: 所有前序模块的导出。
- Produces: `@graph-agent/core` 顶层统一导出全部类型、工厂与事件链工具。

- [ ] **Step 1: 写失败测试(整体替换)`packages/core/test/smoke.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  GENESIS_HASH,
  NodeStatus,
  canonicalJson,
  createAgentIdentity,
  createAgentInput,
  createAgentResult,
  createContextPacket,
  createMessageProposal,
  createNodeBudget,
  createNodeError,
  createSkipContextProposal,
  createSpawnProposal,
  createUsage,
  resultBindingHash,
  sha256,
  usageTotalTokens,
  valueHash,
  verifyEventChain,
} from "../src/index.js";

describe("public API", () => {
  it("re-exports the full core surface", () => {
    expect(typeof canonicalJson).toBe("function");
    expect(typeof sha256).toBe("function");
    expect(typeof valueHash).toBe("function");
    expect(typeof createAgentIdentity).toBe("function");
    expect(typeof createNodeBudget).toBe("function");
    expect(typeof createUsage).toBe("function");
    expect(typeof usageTotalTokens).toBe("function");
    expect(typeof createNodeError).toBe("function");
    expect(typeof createContextPacket).toBe("function");
    expect(typeof createAgentInput).toBe("function");
    expect(typeof createAgentResult).toBe("function");
    expect(typeof createSpawnProposal).toBe("function");
    expect(typeof createMessageProposal).toBe("function");
    expect(typeof createSkipContextProposal).toBe("function");
    expect(typeof resultBindingHash).toBe("function");
    expect(typeof verifyEventChain).toBe("function");
    expect(NodeStatus.COMPLETED).toBe("completed");
    expect(EventType.NODE_STARTED).toBe("node_started");
    expect(GENESIS_HASH).toHaveLength(64);
    expect(EventRecorder).toBeTypeOf("function");
  });

  it("assembles a full AgentResult end-to-end", () => {
    const rec = new EventRecorder("n1", () => 1);
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED, outputValue: "ok" });
    const result = createAgentResult({
      nodeId: "n1",
      status: NodeStatus.COMPLETED,
      output: "ok",
      usage: createUsage({ inputTokens: 2, outputTokens: 3 }),
      events: rec.events,
      spawnProposals: [
        createSpawnProposal({
          proposalId: "p1",
          parentNodeId: "n1",
          generation: 1,
          role: "r",
          objective: "o",
          instructions: "i",
        }),
      ],
    });
    expect(result.status).toBe("completed");
    expect(usageTotalTokens(result.usage)).toBe(5);
    expect(verifyEventChain(result.events)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    // identity/context also compose without error
    createAgentIdentity({ nodeId: "n1", name: "root", role: "r" });
    createAgentInput({
      task: "t",
      context: [createContextPacket({ sourceNodeId: "s", content: "c" })],
    });
    createNodeError({ code: "E", message: "m" });
    createMessageProposal({ proposalId: "m1", sourceNodeId: "a", targetNodeId: "b", content: "x" });
    createSkipContextProposal({ proposalId: "s1", requesterNodeId: "a", sourceNodeId: "b", reason: "r" });
    createNodeBudget();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run packages/core/test/smoke.test.ts`
Expected: FAIL,`index.js` 尚未导出这些符号(仍是 `PACKAGE_NAME` 占位)。

- [ ] **Step 3: 写实现 `packages/core/src/index.ts`(整体替换)**

```ts
export { canonicalJson, sha256, valueHash } from "./hash.js";
export {
  assertBoolean,
  assertBoundedInt,
  assertFinitePositive,
  assertNonEmptyText,
  assertSha256Hex,
  assertUnitInterval,
} from "./guards.js";
export { createAgentIdentity } from "./identity.js";
export type { AgentIdentity } from "./identity.js";
export {
  addUsage,
  createNodeBudget,
  createUsage,
  usageTotalTokens,
} from "./budget.js";
export type { NodeBudget, Usage } from "./budget.js";
export {
  NodeStatus,
  createAgentInput,
  createAgentResult,
  createContextPacket,
  createNodeError,
} from "./result.js";
export type {
  AgentInput,
  AgentResult,
  ContextPacket,
  NodeError,
} from "./result.js";
export {
  createMessageProposal,
  createSkipContextProposal,
  createSpawnProposal,
} from "./proposals.js";
export type {
  MessageProposal,
  SkipContextProposal,
  SpawnProposal,
} from "./proposals.js";
export {
  EventRecorder,
  EventType,
  GENESIS_HASH,
  resultBindingHash,
  verifyEventChain,
} from "./events.js";
export type { RunEvent } from "./events.js";
```

- [ ] **Step 4: 运行全部测试确认通过**

Run: `npm test`
Expected: 全部 test 文件 PASS(hash / guards / identity / budget / result / proposals / events / smoke)。

- [ ] **Step 5: 验证严格模式构建通过(关键收尾)**

Run: `npm run -w @graph-agent/core build`
Expected: `tsc` 严格模式无错误;生成 `dist/index.js` 与全部 `.d.ts`。此步同时确认 Task 6 `result.ts` 的 `import type` 引用现已全部可解析。

- [ ] **Step 6: 验证 Python 未受影响**

Run: `PYTHONPATH=src .venv/bin/python -c "import graph_agent.models, graph_agent.events; print('python ok')"`
Expected: 打印 `python ok`(Python `src/` 未被改动)。若无 `.venv` 则跳过并说明。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/index.ts packages/core/test/smoke.test.ts
git commit -m "feat: expose unified @graph-agent/core public API"
```

---

## 成功标准(全部完成后核对)

1. `npm install` 后 `npm run -w @graph-agent/core build` 严格模式无错误,产出 `dist/`。
2. `npm test` 全绿,覆盖:事件链正常/篡改/断链/伪造/乱序、hash 确定性与 NaN/Infinity 抛错、resultBindingHash 敏感性、守卫的布尔冒充/越界/非有限/空文本/非法 sha256、各模型构造后冻结与默认值、Usage 派生 totalTokens。
3. `@graph-agent/core` 可被 `import`,统一导出全部数据模型、工厂与事件链工具。
4. Python `src/` 与其测试不受影响。

## Self-Review 记录

- **Spec 覆盖**:§3.3 目录结构→Task 1;§3.6 canonical JSON + hash→Task 2;§3.7 fail-closed 守卫→Task 3;§3.4 数据模型(identity/budget/usage/result/context/input/error/proposals)→Task 4–7;§3.5 事件链 + resultBindingHash + verifyEventChain→Task 8;§3.8 测试逐条落在对应 task;index 聚合→Task 9;§3.9 YAGNI→Global Constraints「不做」。全部有对应 task。
- **占位扫描**:无 TBD/TODO;每个代码步给出完整可运行代码。
- **类型一致性**:`createUsage`/`usageTotalTokens`/`addUsage`、`NodeStatus.COMPLETED`、`EventType.NODE_STARTED`、`EventRecorder.record({type,...})`、`verifyEventChain(readonly RunEvent[])`、`resultBindingHash({...})` 在 Task 5/6/8/9 中签名一致;`assertFinitePositive` 在 Task 5 定义并在 Task 9 index 导出。
- **已知取舍**:事件哈希用 `canonicalJson`(spec §3.5)而非 Python 的 `|`-join,故 TS 与 Python 的 `eventHash` 值不互通——地基阶段无跨语言校验需求,可接受;子项目 3 若需读旧 Python checkpoint 再评估。Task 6 `result.ts` 依赖 Task 7/8 的 type-only import,已在 task 内标注 vitest 可绿、`tsc` 全绿在 Task 9 验证。
