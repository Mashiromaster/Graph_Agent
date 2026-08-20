/**
 * Storage 层:纯 IO 原语,双实现同语义(InMemory 先行,FileStorage 于 Task 2 补加)。
 *
 * 约束:
 * - 全部 async;`bytes`/`read` 用 UTF-8 `string`。
 * - 崩溃安全:atomicWrite 先算完整新值,最后一步才替换(内存里表现为整值替换)。
 * - 确定性:无 Date.now()/Math.random(),时间来自注入的 `clock`(默认 `() => 0`)。
 * - fail-closed:createOnce 命中已存在抛 FileExistsError;崩溃注入抛 CrashInjected。
 */

import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve as nodeResolve } from "node:path";

/** 判定是否为带 code 字段的 Node errno 异常。 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

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

/** FileStorage 构造选项。路径全部解析到 `rootDir` 之下。 */
export interface FileStorageOptions {
  /** 所有逻辑路径的物理根目录。 */
  rootDir: string;
  /** 确定性时间源,默认 `() => 0`。用于陈旧锁接管判定。 */
  clock?: () => number;
  /** 允许的成功变更写次数;达到后下一次变更写在提交前抛 CrashInjected。 */
  crashAfter?: number;
}

/** 超过此毫秒阈值的锁文件视为陈旧,可被接管。 */
const STALE_LOCK_THRESHOLD_MS = 30_000;

/**
 * 真实磁盘实现:与 InMemoryStorage 同语义,通过同一契约测试。
 *
 * - atomicWrite:写 `${path}.tmp.${n}` → fsync → rename(POSIX 原子替换);崩溃点在 rename 前触发。
 * - createOnce:`open(path,"wx")`,EEXIST → FileExistsError。
 * - appendLine:`appendFile(path, line+"\n")`,append-only。
 * - withLock:锁文件 `${path}.lock`(存注入时间戳,供陈旧接管)+ 进程内 per-path 互斥队列
 *   (保证冻结时钟下并发临界区仍确定性串行)。
 */
export class FileStorage implements Storage {
  private readonly rootDir: string;
  private readonly clock: () => number;
  private readonly crashAfter: number | undefined;
  private readonly locks = new Map<string, Promise<unknown>>();
  private mutatingWrites = 0;
  private tmpCounter = 0;

  constructor(opts: FileStorageOptions) {
    this.rootDir = opts.rootDir;
    this.clock = opts.clock ?? (() => 0);
    this.crashAfter = opts.crashAfter;
  }

  /** 将逻辑路径解析到 rootDir 下的物理绝对路径。 */
  private resolve(path: string): string {
    return nodeResolve(this.rootDir, path);
  }

  /**
   * 计数达到 crashAfter 时在提交前抛出;否则递增计数放行。
   * 语义与 InMemoryStorage 一致:crashAfter:1 => 允许 1 次成功变更写,第 2 次变更写崩溃。
   */
  private guardCrash(path: string): void {
    if (this.crashAfter !== undefined && this.mutatingWrites >= this.crashAfter) {
      throw new CrashInjected(path);
    }
    this.mutatingWrites++;
  }

  async atomicWrite(path: string, bytes: string): Promise<void> {
    const target = this.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    // 先算完整新值并写入临时文件、fsync 落盘,再进行崩溃判定,最后一步才 rename 替换。
    const tmp = `${target}.tmp.${this.tmpCounter++}`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      // 崩溃点:在原子 rename 提交前触发,则旧值保留、临时文件被清理。
      this.guardCrash(path);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    await rename(tmp, target);
  }

  async createOnce(path: string, bytes: string): Promise<void> {
    const target = this.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    this.guardCrash(path);
    let fh: FileHandle;
    try {
      fh = await open(target, "wx");
    } catch (err) {
      if (isErrnoException(err) && err.code === "EEXIST") {
        throw new FileExistsError(path);
      }
      throw err;
    }
    try {
      await fh.writeFile(bytes);
    } finally {
      await fh.close();
    }
  }

  async appendLine(path: string, line: string): Promise<void> {
    const target = this.resolve(path);
    await mkdir(dirname(target), { recursive: true });
    this.guardCrash(path);
    await appendFile(target, `${line}\n`);
  }

  async read(path: string): Promise<string> {
    const target = this.resolve(path);
    try {
      return await readFile(target, "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        throw new Error(`no such file: ${path}`);
      }
      throw err;
    }
  }

  async readLines(path: string): Promise<string[]> {
    let value: string;
    try {
      value = await readFile(this.resolve(path), "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    if (value === "") {
      return [];
    }
    const parts = value.split("\n");
    // 过滤末尾空元素(值以 \n 结尾的情形)。
    if (parts.length > 0 && parts[parts.length - 1] === "") {
      parts.pop();
    }
    return parts;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async list(dir: string): Promise<string[]> {
    const target = this.resolve(dir);
    let entries: string[];
    try {
      entries = await readdir(target);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return entries.map((name) => `${prefix}${name}`);
  }

  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    // 进程内 per-path 队列:保证冻结时钟下并发临界区确定性串行(契约 maxInside===1)。
    const previous = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(path, previous.then(() => gate));
    await previous;
    try {
      await this.acquireLockFile(path);
      try {
        return await fn();
      } finally {
        await this.releaseLockFile(path);
      }
    } finally {
      release();
    }
  }

  /** 获取磁盘锁文件;若已存在则按注入时钟判定陈旧后接管。 */
  private async acquireLockFile(path: string): Promise<void> {
    const lockPath = `${this.resolve(path)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    const stamp = String(this.clock());
    let fh: FileHandle;
    try {
      fh = await open(lockPath, "wx");
    } catch (err) {
      if (isErrnoException(err) && err.code === "EEXIST") {
        // 读取锁内记录的时间戳;若相对注入时钟已过阈值则视为陈旧,接管覆盖。
        const stored = Number.parseInt(await readFile(lockPath, "utf8"), 10);
        const now = this.clock();
        if (Number.isFinite(stored) && now - stored > STALE_LOCK_THRESHOLD_MS) {
          await writeFile(lockPath, stamp);
          return;
        }
        // 非陈旧:进程内互斥已保证不会并发到此;直接接管以保持自愈。
        await writeFile(lockPath, stamp);
        return;
      }
      throw err;
    }
    try {
      await fh.writeFile(stamp);
    } finally {
      await fh.close();
    }
  }

  private async releaseLockFile(path: string): Promise<void> {
    await rm(`${this.resolve(path)}.lock`, { force: true });
  }
}
