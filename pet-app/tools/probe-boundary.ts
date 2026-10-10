/**
 * probe-boundary.ts —— 验两件事（不叫模型，几秒钟跑完，且完全隔离）：
 *   1. 硬门判定：哪些路径任何情况都不许碰
 *   2. 仓库外文件的"存档 → 改动 → 撤回"闭环（这是让桌宠能改任意文件的关键）
 *
 * 隔离手段：把 APPDATA 指到临时目录，所以它写的是临时存档，不会污染你真实的
 * %APPDATA%\肆\pi-checkpoints.json；测试文件也放在临时目录里，不碰你桌面。
 *
 * 注意：这里用静态 import（tsx 在 CJS 模式下不支持顶层 await），
 * 而 petRoot() 是惰性读取 APPDATA 的，所以在 main() 里设也来得及。
 *
 * 运行：npx tsx tools/probe-boundary.ts
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describeWorkspace } from '../src/main/pi-engine';
import {
  appendCheckpoint,
  backupFile,
  isGitIgnored,
  isProtectedPath,
  restoreLatestCheckpoint,
} from '../src/main/pi-checkpoint';

const sandbox = path.join(os.tmpdir(), `si-probe-${Date.now()}`);

async function decide(cwd: string, target: string): Promise<string> {
  const blocked = isProtectedPath(target);
  if (blocked !== undefined) return `🚫 硬门拦截（受保护：${blocked}）`;
  if (path.isAbsolute(target) && !target.startsWith(cwd)) return '✅ 允许（仓库外：会存文件副本）';
  if (await isGitIgnored(cwd, target)) return '✅ 允许（仓库内但被 ignore：会存文件副本）';
  return '✅ 允许（仓库内：靠 git 快照）';
}

async function main(): Promise<void> {
  // 必须在使用存档功能之前改掉 APPDATA
  process.env.APPDATA = path.join(sandbox, 'appdata');
  mkdirSync(process.env.APPDATA, { recursive: true });

  const cwd = describeWorkspace().dir;
  console.log(`工作目录 : ${cwd}`);
  console.log(`隔离存档 : ${process.env.APPDATA}\n`);

  console.log('--- 第一部分：路径判定 ---');
  const cases = [
    'src/main.ts',
    'qa/manual-checklist.md',
    'C:\\Users\\93763\\Desktop\\试验文件.txt',
    'D:\\别的地方\\笔记.md',
    '.build/probe-pi.log',
    'release/肆.exe',
    '.env',
    'node_modules/electron/package.json',
    'package-lock.json',
    '.pet-builder.json',
  ];
  for (const target of cases) {
    console.log(`${target.padEnd(46)} ${await decide(cwd, target)}`);
  }

  console.log('\n--- 第二部分：仓库外文件的"存档 → 改 → 撤回"闭环 ---');
  const outside = path.join(sandbox, '外面', '试验文件.txt');
  mkdirSync(path.dirname(outside), { recursive: true });
  const original = '肆是猪';
  writeFileSync(outside, original, 'utf8');
  console.log(`测试文件 : ${outside}`);
  console.log(`动手前   : 「${original}」`);

  const entry = backupFile(`probe-${randomUUID()}`, outside);
  appendCheckpoint({
    at: new Date().toISOString(),
    cwd,
    reason: '探针：仓库外文件副本',
    files: [entry],
  });
  console.log(`副本已存 : ${entry.backup ? '是' : '否（原文件本来不存在）'}`);

  writeFileSync(outside, '肆改的。ss写的原话已被推翻。', 'utf8');
  console.log(`被改后   : 「${readFileSync(outside, 'utf8')}」`);

  await restoreLatestCheckpoint(cwd);
  const after = readFileSync(outside, 'utf8');
  console.log(`撤回后   : 「${after}」`);
  console.log(after === original
    ? '✅ 仓库外的文件也撤回成功了 —— 桌宠可以改任意文件，而且回得去'
    : '❌ 没还原（需要人工看一眼）');

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n（已清理临时目录 ${sandbox}）`);
}

void main().catch((error) => {
  console.error('[探针失败]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
