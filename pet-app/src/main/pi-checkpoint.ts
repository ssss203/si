/**
 * pi-checkpoint.ts —— agent 动手前的自动存档 + 受保护路径拦截（阶段 E / F 第一层）。
 *
 * 为什么需要它：开了 edit/write 之后，肆可以改自己的代码。改坏了必须能一键回去 ——
 * 没有安全网就绝不开编辑权限。
 *
 * 存档机制（关键设计，和官方示例不同）：
 *   一个用户回合里，第一次真正要动文件之前，存一次档：
 *     · 工作区是干净的 → 直接记下 HEAD（HEAD 就是这一刻的状态）
 *     · 工作区有改动   → git add -A 后提交一个 checkpoint(肆) 的 commit，记下它
 *   记录写到 %APPDATA%\肆\pi-checkpoints.json，只保留最近 20 条。
 *   撤回 = git reset --hard <记录里的 commit>。
 *
 * 为什么不用官方 examples/extensions/git-checkpoint.ts 的 `git stash create`：
 *   它在**干净的工作区**上返回空字符串（没有 stash 对象），而"agent 动手前"最常见
 *   的情形正好就是干净仓库 —— 那样会得到"没有存档"，等于没有安全网。
 *
 * 受保护路径（阶段 F 的第一道门）：agent 永远不许碰 .env / .git/ / node_modules/ /
 * package-lock.json / .pet-builder.json —— 前两个是密钥和版本库，后三个是模板基础设施。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

/** 会被拦截并先存档的工具（只读工具不在其中） */
const MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);

/** agent 永远不许碰的路径片段 */
const PROTECTED_PATTERNS = ['.env', '.git/', 'node_modules/', 'package-lock.json', '.pet-builder.json'];

export interface CheckpointRecord {
  ref: string;
  at: string;
  cwd: string;
  reason: string;
}

/** 存档记录文件：%APPDATA%\肆\pi-checkpoints.json */
function statePath(): string {
  const root = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(root, '肆', 'pi-checkpoints.json');
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

/** 最近一次存档（可限定工作目录） */
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

/**
 * 记一次存档。返回记录。
 * 工作区干净时记 HEAD（不产生多余提交）；有改动时先提交成 checkpoint commit。
 */
export async function createCheckpoint(cwd: string, reason: string): Promise<CheckpointRecord> {
  const status = await git(cwd, ['status', '--porcelain']);
  let ref: string;
  if (status.length > 0) {
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '--no-verify', '-m', `checkpoint(肆): ${reason}`]);
    ref = await git(cwd, ['rev-parse', 'HEAD']);
  } else {
    ref = await git(cwd, ['rev-parse', 'HEAD']);
  }
  const record: CheckpointRecord = { ref, at: new Date().toISOString(), cwd, reason };
  const records = readCheckpoints();
  records.push(record);
  writeCheckpoints(records);
  return record;
}

/**
 * 撤回到最近一次存档。
 * 注意：`git reset --hard` 只重置被 git 跟踪的文件；agent 事后新建的**未跟踪**文件
 * 不会被删掉（想连它们一起清掉，得手工删或扩展这里）。
 */
export async function restoreLatestCheckpoint(cwd: string): Promise<CheckpointRecord | undefined> {
  const latest = readLatestCheckpoint(cwd);
  if (!latest) return undefined;
  await git(cwd, ['reset', '--hard', latest.ref]);
  return latest;
}

/** 这道门挡不挡这个路径（探针/诊断用） */
export function isProtectedPath(target: string): string | undefined {
  return PROTECTED_PATTERNS.find((pattern) => target.includes(pattern));
}

/**
 * 装进 pi 会话的扩展：改动前存档 + 拦受保护路径。
 * 一个回合只存一次档（`agent_settled` 时重置）。
 */
export function createCheckpointExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let checkpointedThisTurn = false;

    pi.on('tool_call', async (event) => {
      const toolName = typeof event.toolName === 'string' ? event.toolName : '';
      if (!MUTATING_TOOLS.has(toolName)) return undefined;

      // 第一道门：受保护路径直接拦掉
      const input = event.input as { path?: unknown } | undefined;
      const target = typeof input?.path === 'string' ? input.path : '';
      const blocked = isProtectedPath(target);
      if (blocked !== undefined) {
        return { block: true, reason: `受保护路径（命中「${blocked}」）不允许修改：${target}` };
      }

      // 一个回合只存一次档
      if (!checkpointedThisTurn) {
        checkpointedThisTurn = true;
        try {
          await createCheckpoint(options.cwd, `${toolName} 前自动存档`);
        } catch (error) {
          // 存档失败就不许动手 —— 没有安全网，就不开编辑
          const message = error instanceof Error ? error.message : String(error);
          return { block: true, reason: `自动存档失败，已阻止 ${toolName}：${message}` };
        }
      }

      return undefined;
    });

    pi.on('agent_settled', async () => {
      checkpointedThisTurn = false;
    });
  };
}
