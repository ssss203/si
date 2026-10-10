/**
 * probe-skills-api.ts —— 不花钱、不启 Electron 的功能 B 全链路自测。
 *
 * 它验的：
 *   ① create_skill 落在 skills-pending（待批准），且真能被 pi 的加载器扫出 frontmatter
 *   ② 批准（approve）/ 停用（disable）/ 删除（remove）的**文件语义**：
 *      文件在 skills-pending ⇄ skills 之间移动、删掉之后就没了
 *      —— 这三个动作 main.ts 的 IPC handler 调的就是这里的 moveSkillFile / removeSkillFile
 *   ③ 名字白名单挡得住路径穿越（`../evil`、`a/b`、`..` 之类全都拒绝）
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-skills-api.ts
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  assertSkillName,
  createSkillsExtension,
  describeSkills,
  moveSkillFile,
  removeSkillFile,
  skillDirs,
} from '../src/main/pi-skills';

/** 工具定义（只用到 name / execute，其余字段跟本探针无关） */
interface ToolLike {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }>;
}

/** 把扩展工厂跑一遍，抓出它注册的两个工具 */
async function collectTools(skillsRoot: string): Promise<Map<string, ToolLike>> {
  const tools = new Map<string, ToolLike>();
  const fakeApi = {
    on: () => { },
    registerTool: (tool: ToolLike) => { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  await createSkillsExtension({ cwd: process.cwd(), skillsRoot })(fakeApi);
  return tools;
}

function report(label: string, ok: boolean, detail = ''): boolean {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
  return ok;
}

async function main(): Promise<void> {
  const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'si-probe-skills-api-'));
  const { enabledDir, pendingDir } = skillDirs(skillsRoot);
  let ok = true;

  try {
    const tools = await collectTools(skillsRoot);
    ok = report('扩展注册了 create_skill / list_skills', tools.has('create_skill') && tools.has('list_skills'),
      [...tools.keys()].join(', ')) && ok;

    // ① 写技能
    const create = tools.get('create_skill');
    const result = await create!.execute('probe', {
      name: 'probe-api',
      description: '自测用的技能。当这个探针跑起来时使用。',
      body: '# 正文\n\n第一行。\n',
    });
    const file = path.join(pendingDir, 'probe-api.md');
    const raw = await readFile(file, 'utf8');
    ok = report('create_skill 写在 skills-pending', raw.includes('name: probe-api')) && ok;
    ok = report('返回给模型的话里提到"等主人批准"', /主人在?.*面板|批准/.test(String(result.content[0]?.text))) && ok;

    // ② 非法名字必须被拒（路径穿越）
    const badNames = ['../evil', 'a/b', '..', '.hidden', 'a b', '', 'a'.repeat(50), 'con:1', 'a\\b'];
    for (const bad of badNames) {
      let rejected = false;
      try {
        assertSkillName(bad);
      } catch {
        rejected = true;
      }
      ok = report(`拒绝非法技能名 ${JSON.stringify(bad)}`, rejected) && ok;
    }
    // 工具层也要拒（返回 ok:false，而不是抛出去）
    const badResult = await create!.execute('probe', {
      name: '../evil',
      description: 'x',
      body: 'y',
    });
    ok = report('create_skill 对非法名字返回错误而不是抛异常', /❌/.test(String(badResult.content[0]?.text))) && ok;

    // ③ 批准：pending → enabled
    await moveSkillFile(skillsRoot, 'probe-api', 'approve');
    let overview = await describeSkills(skillsRoot);
    ok = report('approve 后出现在已启用里',
      overview.enabled.some((s) => s.name === 'probe-api') && !overview.pending.some((s) => s.name === 'probe-api')) && ok;

    // ④ 停用：enabled → pending
    await moveSkillFile(skillsRoot, 'probe-api', 'disable');
    overview = await describeSkills(skillsRoot);
    ok = report('disable 后回到待批准里',
      overview.pending.some((s) => s.name === 'probe-api') && !overview.enabled.some((s) => s.name === 'probe-api')) && ok;

    // ⑤ 删除：两边都没了
    const removed = await removeSkillFile(skillsRoot, 'probe-api');
    overview = await describeSkills(skillsRoot);
    ok = report('remove 之后两个目录都干净',
      removed && overview.enabled.length === 0 && overview.pending.length === 0) && ok;

    // ⑥ list_skills 读得回已启用 / 待批准两类（先重新写一个再批准）
    await create!.execute('probe', {
      name: 'probe-api',
      description: '自测用的技能。当这个探针跑起来时使用。',
      body: '# 正文\n',
    });
    await moveSkillFile(skillsRoot, 'probe-api', 'approve');
    const list = tools.get('list_skills');
    const listText = String((await list!.execute('probe', {}))?.content?.[0]?.text ?? '');
    ok = report('list_skills 能报出已启用列表', listText.includes('已启用') && listText.includes('probe-api')) && ok;

    console.log(`\n人看的路径核对：enabledDir=${enabledDir} / pendingDir=${pendingDir}`);
  } finally {
    await rm(skillsRoot, { recursive: true, force: true });
    console.log('\n临时技能根已删除');
  }

  if (!ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
