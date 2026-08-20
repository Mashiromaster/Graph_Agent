/**
 * Storage 层:纯 IO 原语,双实现同语义(InMemory 先行,FileStorage 于 Task 2 补加)。
 *
 * 约束:
 * - 全部 async;`bytes`/`read` 用 UTF-8 `string`。
 * - 崩溃安全:atomicWrite 先算完整新值,最后一步才替换(内存里表现为整值替换)。
 * - 确定性:无 Date.now()/Math.random(),时间来自注入的 `clock`(默认 `() => 0`)。
 * - fail-closed:createOnce 命中已存在抛 FileExistsError;崩溃注入抛 CrashInjected。
 */

/** createOnce 命中已存在路径时抛出(wx 语义)。 */
export class FileExistsError extends Error {
  constructor(path: string) {
    super(`file already exists: ${path}`);
    this.name = "FileExistsError";
  }
}

/** 崩溃注入:写计数达到 crashAfter 后在提交前抛出,用于恢复测试。 */
export class CrashInjected extends Error {
  constructor(path: string) {
    super(`crash injected before commit: ${path}`);
    this.name = "CrashInjected";
  }
}

/** 纯 IO 原语接口。双实现(InMemoryStorage / FileStorage)须通过同一契约测试。 */
export interface Storage {
  /** 原子写:先算完整新值,最后一步替换。崩溃点在提交前触发则抛错、旧值保留。 */
  atomicWrite(path: string, bytes: string): Promise<void>;
  /** 仅当路径不存在时创建;否则抛 FileExistsError(wx 语义)。 */
  createOnce(path: string, bytes: string): Promise<void>;
  /** append-only 追加一行(不含换行符的逻辑行)。 */
  appendLine(path: string, line: string): Promise<void>;
  /** 读取整个文件内容(UTF-8)。 */
  read(path: string): Promise<string>;
  /** 按行读取(顺序保留,无空尾元素)。 */
  readLines(path: string): Promise<string[]>;
  /** 路径是否存在。 */
  exists(path: string): Promise<boolean>;
  /** 列出目录下的路径。 */
  list(dir: string): Promise<string[]>;
  /** 持锁执行 fn,finally 释放;并发临界区串行化。 */
  withLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

/** InMemoryStorage 构造选项。 */
export interface InMemoryStorageOptions {
  /** 确定性时间源,默认 `() => 0`。 */
  clock?: () => number;
  /** 允许的成功变更写次数;达到后下一次变更写在提交前抛 CrashInjected。 */
  crashAfter?: number;
}

/**
 * 内存实现:整文件存于 Map<string,string>;withLock 用 per-path promise 队列串行化。
 */
export class InMemoryStorage implements Storage {
  private readonly files = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly clock: () => number;
  private readonly crashAfter: number | undefined;
  private mutatingWrites = 0;

  constructor(opts?: InMemoryStorageOptions) {
    this.clock = opts?.clock ?? (() => 0);
    this.crashAfter = opts?.crashAfter;
  }

  /**
   * 计数达到 crashAfter 时在提交前抛出;否则递增计数放行。
   * 语义(以契约测试为准):crashAfter:1 => 允许 1 次成功变更写,第 2 次变更写崩溃。
   */
  private guardCrash(path: string): void {
    if (this.crashAfter !== undefined && this.mutatingWrites >= this.crashAfter) {
      throw new CrashInjected(path);
    }
    this.mutatingWrites++;
  }

  async atomicWrite(path: string, bytes: string): Promise<void> {
    // 先算完整新值(此处即 bytes),再进行崩溃判定,最后一步才替换。
    const nextValue = bytes;
    this.guardCrash(path);
    this.files.set(path, nextValue);
  }

  async createOnce(path: string, bytes: string): Promise<void> {
    if (this.files.has(path)) {
      throw new FileExistsError(path);
    }
    this.guardCrash(path);
    this.files.set(path, bytes);
  }

  async appendLine(path: string, line: string): Promise<void> {
    this.guardCrash(path);
    const existing = this.files.get(path);
    const next = existing === undefined || existing === "" ? line : `${existing}\n${line}`;
    this.files.set(path, next);
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined) {
      throw new Error(`no such file: ${path}`);
    }
    return value;
  }

  async readLines(path: string): Promise<string[]> {
    const value = this.files.get(path);
    if (value === undefined || value === "") {
      return [];
    }
    // 过滤末尾空元素(值以 \n 结尾的情形)。
    const parts = value.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") {
      parts.pop();
    }
    return parts;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return [...this.files.keys()].filter((k) => k.startsWith(prefix));
  }

  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    // per-path promise 队列:等待前一个临界区结束,再串行运行本次。
    const previous = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 后来者排在 gate 之后;前一个完成后本次方可进入。
    this.locks.set(path, previous.then(() => gate));
    await previous;
    // clock 保留供陈旧锁接管语义(Task 2 FileStorage 使用);此处触达以满足确定性时间源约定。
    void this.clock;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
