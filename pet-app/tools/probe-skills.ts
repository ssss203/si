/**
 * probe-skills.ts —— 验证「技能工具」（功能 B）：肆能不能调用 create_skill，
 * 在 <petRoot>/skills-pending/ 里落下一个**符合 pi 官方格式**的技能文件。
 *
 * 它验到的（走的是 pi-engine 里真正注册的那条链，不是另起一份工厂）：
 *   ① create_skill / list_skills 确实进了工具白名单（describeWorkspace().tools）
 *   ② 模型真的会调这两个工具
 *   ③ 文件落在 skills-pending（待批准）里，frontmatter 能被按官方格式解析出来
 * 它验不到的：
 *   ④ "技能真的被 pi 加载了" —— 那要 pi 重建会话时去扫 <petRoot>/skills，见 README 说明。
 *
 * 运行（两把钥匙都会换成本机临时目录，桌宠的真实记忆和真实技能一个字节都不碰）：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   $env:PET_PI_ROOT="$env:TEMP\si-probe-root"
 *   $env:PET_PI_SESSION_DIR="$env:TEMP\si-probe-root\pi-sessions"
 *   npx tsx tools/probe-skills.ts
 * 脚本跑完会递归删掉 PET_PI_ROOT；加 -Keep 可以留着人工看。
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SKILL_NAME_PATTERN, describeSkills, parseSkillFile, skillDirs } from '../src/main/pi-skills';
import { describeWorkspace, piChatStream, type EngineEvent } from '../src/main/pi-engine';

/** 探针用的技能名（固定值，方便跑完按名字确认/清理） */
const PROBE_SKILL_NAME = 'probe-water-helper';

/** 桌宠配置里读 API Key（只用来建会话，绝不打印） */
async function loadPetConfig(): Promise<{ apiKey: string; model: string }> {
  const file = path.join(process.env.APPDATA ?? '', '肆', 'coze-config.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as {
    deepseekApiKey?: unknown;
    deepseekModel?: unknown;
  };
  if (typeof parsed.deepseekApiKey !== 'string' || !parsed.deepseekApiKey) {
    throw new Error('桌宠配置里没有 deepseekApiKey');
  }
  return {
    apiKey: parsed.deepseekApiKey,
    model: typeof parsed.deepseekModel === 'string' ? parsed.deepseekModel : 'deepseek-chat',
  };
}

async function main(): Promise<void> {
  const keep = process.argv.includes('-Keep');
  const skillsRoot = (process.env.PET_PI_ROOT ?? '').trim();
  if (skillsRoot.length === 0) {
    // 没有 PET_PI_ROOT 就会往 %APPDATA%\肆\skills-pending 里写 —— 拒绝，别污染真实桌宠
    throw new Error('请先设置 PET_PI_ROOT 指向一个临时目录再跑这个探针');
  }

  const { apiKey, model } = await loadPetConfig();
  const systemPrompt = JSON.parse(await readFile(path.join(process.cwd(), 'role-card.json'), 'utf8'))
    .systemPrompt as string;
  const { pendingDir } = skillDirs(skillsRoot);
  const workspace = describeWorkspace();

  console.log('========================================');
  console.log(`开放工具: ${workspace.tools.join(', ')}`);
  console.log(`白名单里有 create_skill: ${workspace.tools.includes('create_skill') ? '✅' : '❌'}`);
  console.log(`白名单里有 list_skills:  ${workspace.tools.includes('list_skills') ? '✅' : '❌'}`);
  console.log(`临时技能根 (PET_PI_ROOT): ${skillsRoot}`);
  console.log(`会话目录: ${process.env.PET_PI_SESSION_DIR ?? '(未设置！会写进桌宠真实记忆)'}`);
  console.log('========================================\n');

  const toolCalls: string[] = [];
  await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: '现在做两件事，都要真的调工具：\n'
      + '① 用 list_skills 看看你现在有哪些技能；\n'
      + `② 用 create_skill 提交一个技能：name 必须是 ${PROBE_SKILL_NAME}，`
      + 'description 写“提醒主人喝水。当主人长时间没喝水、或者提到喝水时使用。”，'
      + 'body 写三条给未来的自己的提醒。\n'
      + '最后用一句话汇报。',
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: (event: EngineEvent) => {
      if (event.type === 'tool_execution_start') {
        toolCalls.push(event.toolName ?? '未知');
        console.log(`\n[工具调用] ${event.toolName}`);
      }
    },
  });

  console.log('\n\n--- 结果 ---');
  console.log(`工具调用: ${toolCalls.join(', ') || '（无）'}`);

  const overview = await describeSkills(skillsRoot);
  const created = overview.pending.find((skill) => skill.name === PROBE_SKILL_NAME);
  let ok = Boolean(created);

  if (created) {
    const file = path.join(pendingDir, `${PROBE_SKILL_NAME}.md`);
    const raw = await readFile(file, 'utf8');
    const parsed = parseSkillFile(raw);
    console.log(`\n落盘文件: ${file}`);
    console.log('--- 文件内容 ---');
    console.log(raw.trimEnd());
    console.log('----------------');
    console.log(`frontmatter 解析: name=${parsed.name} / description=${parsed.description.slice(0, 30)}…`);
    console.log(`文件名过白名单正则: ${SKILL_NAME_PATTERN.test(PROBE_SKILL_NAME) ? '✅' : '❌'}`);
    if (parsed.description.trim().length === 0) {
      console.log('❌ description 是空的 —— 这种技能 pi 不会加载');
      ok = false;
    } else {
      console.log('✅ 技能落在 skills-pending（待批准），此时 pi 还不会加载它');
    }
  } else {
    console.log('\n❌ skills-pending 里没找到探针技能');
  }
  const leaked = overview.enabled.some((skill) => skill.name === PROBE_SKILL_NAME);
  console.log(`已启用目录里有没有它（应该没有）: ${leaked ? '❌ 有' : '✅ 没有'}`);

  if (keep) {
    console.log(`\n(-Keep) 临时目录保留在：${skillsRoot}`);
  } else {
    await rm(skillsRoot, { recursive: true, force: true });
    console.log('\n临时技能根已递归删除');
  }
  if (!ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
