/**
 * pi-checkpoint.ts —— agent 动手前的自动存档 + 硬门拦截（阶段 E / F 的地基）。
 *
 * 核心承诺：**只要允许肆改，就必须能撤回。** 为此有两层存档：
 *
 *   第一层 · git 快照（管整个仓库）
 *     一个回合里第一次要动文件之前存一次：
 *       · 工作区干净 → 记下 HEAD（HEAD 就是这一刻的状态，不产生多余提交）
 *       · 工作区有改动 → git add -A 后提交一个 checkpoint(肆) 的提交，记下它
 *
 *   第二层 · 文件副本（管仓库外的文件）
 *     每次要动的文件，先在 %APPDATA%\肆\pi-backups\<批次>\ 里复制一份；
 *     撤回时复制回去；如果是新建的文件，撤回时就删掉。
 *     → 这就是"桌宠能改桌面上/别的盘里的文件"还能撤回的关键。
 *
 * 为什么两层都要：git 只管得着仓库里的文件。桌宠要带工具性质（改用户随便哪个文件），
 * 就必须自己管副本 —— 否则"改坏了能回滚"这个承诺对仓库外的文件是假的。
 *
 * 硬门（连授权都不放行，必须改代码才能解除）：
 *   .env / .git/ / node_modules/ / package-lock.json / .pet-builder.json
 *   —— 前两个是密钥和版本库，后三个是模板基础设施。
 *
 * TODO(下一步)：
 *   · 授权门：改工作目录**外**的文件前，在聊天窗口弹一次"允许/拒绝"（阶段 F 的 UX 层）
 *   · bash 没有 path 参数，放开 bash 时必须另做命令白名单
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

/** 会被拦截并先存档的工具（只读工具不在其中） */
const MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);

/** 硬门：agent 永远不许碰的路径片段 */
const PROTECTED_PATTERNS = ['.env', '.git/', 'node_modules/', 'package-lock.json', '.pet-builder.json'];

/** 被动的文件（或新建的文件）—— 撤回时要还原成什么样 */
export interface RevertFileEntry {
  /** 原始绝对路径 */
  original: string;
  /** 副本路径；original 本来不存在时为 undefined（撤回 = 删掉它） */
  backup?: string;
  /** 动手之前这个文件存在吗 */
  existed: boolean;
}

/** 一个"撤回点" = 一个用户回合里所有存档的集合 */
export interface CheckpointRecord {
  /** git 快照（仓库里的文件靠它还原）；没有仓库改动时也可能有 */
  ref?: string;
  at: string;
  cwd: string;
  reason: string;
  /** 这一回合动过的文件（仓库外的文件靠副本还原） */
  files?: RevertFileEntry[];
}

function petRoot(): string {
  const root = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(root, '肆');
}

function statePath(): string {
  return path.join(petRoot(), 'pi-checkpoints.json');
}

function backupRoot(): string {
  return path.join(petRoot(), 'pi-backups');
}

export function readCheckpoints(): CheckpointRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as CheckpointRecord[]) : [];
  } catch {
    return [];
  }
}

function writeCheckpoints(records: CheckpointRecord[]): void {
  const file = statePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(records.slice(-20), null, 2)}\n`, 'utf8');
}

/** 最近一次撤回点（可限定工作目录） */
export function readLatestCheckpoint(cwd?: string): CheckpointRecord | undefined {
  const records = readCheckpoints();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && (cwd === undefined || record.cwd === cwd)) return record;
  }
  return undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** 目标路径是否在工作目录内（含目录本身） */
export function isInsideWorkspace(cwd: string, target: string): boolean {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** 这个路径是否被 git 忽略（被忽略 = git 快照管不着 = 只能靠文件副本） */
export async function isGitIgnored(cwd: string, target: string): Promise<boolean> {
  try {
    // 退出码 0 = 被忽略；1 = 没被忽略（execFile 在非 0 退出时会 reject）
    await execFileAsync('git', ['check-ignore', '--quiet', '--', target], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 这道门挡不挡这个路径（探针/诊断用） */
export function isProtectedPath(target: string): string | undefined {
  return PROTECTED_PATTERNS.find((pattern) => target.includes(pattern));
}

/** 把绝对路径变成副本目录里安全的相对路径：C:\a\b.txt → C\a\b.txt */
function backupPathFor(batchId: string, original: string): string {
  const parsed = path.parse(original);
  const drive = parsed.root.replace(/[:\\/]/g, '') || 'root';
  const rest = original.slice(parsed.root.length).split(/[\\/]/).filter((part) => part.length > 0);
  return path.join(backupRoot(), batchId, drive, ...rest);
}

/**
 * git 快照：记 HEAD，或者把当前工作区提交成一个 checkpoint 提交。
 * 失败不致命（文件副本那一层还在），所以这里吞掉异常并返回 undefined。
 */
export async function createGitCheckpoint(cwd: string, reason: string): Promise<string | undefined> {
  try {
    const status = await git(cwd, ['status', '--porcelain']);
    if (status.length > 0) {
      await git(cwd, ['add', '-A']);
      await git(cwd, ['commit', '--no-verify', '-m', `checkpoint(肆): ${reason}`]);
      return await git(cwd, ['rev-parse', 'HEAD']);
    }
    return await git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
}

/** 兼容旧名字（探针在用） */
export async function createCheckpoint(cwd: string, reason: string): Promise<CheckpointRecord> {
  const ref = await createGitCheckpoint(cwd, reason);
  const record: CheckpointRecord = { ref, at: new Date().toISOString(), cwd, reason };
  const records = readCheckpoints();
  records.push(record);
  writeCheckpoints(records);
  return record;
}

/**
 * 撤回到最近一次撤回点：
 *   1. 先 git reset --hard 回快照（还原仓库里被跟踪的文件）
 *   2. 再把这一回合动过的仓库外文件从副本复制回来（新建的删掉）
 */
export async function restoreLatestCheckpoint(cwd: string): Promise<CheckpointRecord | undefined> {
  const latest = readLatestCheckpoint(cwd);
  if (!latest) return undefined;

  if (latest.ref) {
    await git(cwd, ['reset', '--hard', latest.ref]);
  }

  for (const entry of latest.files ?? []) {
    try {
      if (entry.existed && entry.backup && existsSync(entry.backup)) {
        mkdirSync(path.dirname(entry.original), { recursive: true });
        copyFileSync(entry.backup, entry.original);
      } else if (!entry.existed) {
        rmSync(entry.original, { force: true });
      }
    } catch {
      // 单个文件还原失败不该中断整体撤回；调用方可以从记录里看到有哪些文件
    }
  }

  return latest;
}

/** 把一条撤回点追加到记录文件（会话里由扩展调用；探针也用） */
export function appendCheckpoint(record: CheckpointRecord): void {
  const records = readCheckpoints();
  records.push(record);
  writeCheckpoints(records);
}

/** 给单个文件建立副本（会话里由扩展自动调用；探针也用） */
export function backupFile(batchId: string, target: string): RevertFileEntry {
  const existed = existsSync(target);
  if (!existed) return { original: target, existed };
  const backup = backupPathFor(batchId, target);
  mkdirSync(path.dirname(backup), { recursive: true });
  copyFileSync(target, backup);
  return { original: target, existed, backup };
}

/**
 * 装进 pi 会话的扩展。
 * - 硬门：受保护路径直接拦
 * - 一个回合第一次动文件前做 git 快照
 * - 每次要动的文件都先复制一份副本（仓库外的文件就靠这个才能撤回）
 */
export function createCheckpointExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let gitCheckpointedThisTurn = false;
    let currentBatchId: string | undefined;
    let currentEntries: Map<string, RevertFileEntry> | undefined;

    function batch(): { id: string; entries: Map<string, RevertFileEntry> } {
      if (currentBatchId === undefined || currentEntries === undefined) {
        currentBatchId = new Date().toISOString().replace(/[:.]/g, '-');
        currentEntries = new Map<string, RevertFileEntry>();
      }
      return { id: currentBatchId, entries: currentEntries };
    }

    pi.on('tool_call', async (event) => {
      const toolName = typeof event.toolName === 'string' ? event.toolName : '';
      if (!MUTATING_TOOLS.has(toolName)) return undefined;

      const input = event.input as { path?: unknown } | undefined;
      const rawTarget = typeof input?.path === 'string' ? input.path : '';
      const target = rawTarget.length > 0 ? path.resolve(options.cwd, rawTarget) : '';

      // 硬门：受保护路径直接拦（这条连"授权"都不放行）
      const blocked = isProtectedPath(rawTarget) ?? isProtectedPath(target);
      if (blocked !== undefined) {
        return { block: true, reason: `受保护路径（命中「${blocked}」）不允许修改：${rawTarget}` };
      }

      // 第一层：一个回合只做一次 git 快照
      if (!gitCheckpointedThisTurn) {
        gitCheckpointedThisTurn = true;
        await createGitCheckpoint(options.cwd, `${toolName} 前自动存档`);
      }

      // 第二层：给这次要动的文件存副本（仓库外的文件全靠它）
      if (target.length > 0) {
        const { id, entries } = batch();
        if (!entries.has(target)) {
          const existed = existsSync(target);
          let backup: string | undefined;
          if (existed) {
            backup = backupPathFor(id, target);
            try {
              mkdirSync(path.dirname(backup), { recursive: true });
              copyFileSync(target, backup);
            } catch (error) {
              // 副本都存不下来，就不能让它动这个文件
              const message = error instanceof Error ? error.message : String(error);
              return { block: true, reason: `无法为 ${rawTarget} 建立副本，已阻止 ${toolName}：${message}` };
            }
          }
          entries.set(target, { original: target, backup, existed });
        }
      }

      return undefined;
    });

    // 回合结束：把这一回合的撤回点落盘
    pi.on('agent_settled', async () => {
      if (currentBatchId !== undefined && currentEntries !== undefined && currentEntries.size > 0) {
        const records = readCheckpoints();
        records.push({
          at: new Date().toISOString(),
          cwd: options.cwd,
          reason: '动手前自动存档',
          files: [...currentEntries.values()],
        });
        writeCheckpoints(records);
      }
      gitCheckpointedThisTurn = false;
      currentBatchId = undefined;
      currentEntries = undefined;
    });
  };
}
