/**
 * probe-skills-load.ts —— 不花 API 额度的那半边验证：**pi 到底会不会加载我们生成的技能文件**。
 *
 * probe-skills.ts 验的是"肆能写"；这个探针验的是"pi 能读"，也就是
 * 「技能真的被 pi 加载了」这条 —— 用 pi 的 DefaultResourceLoader 按桌宠真实的配置方式
 * （additionalSkillPaths 指向 <root>/skills）扫一遍我们生成的文件，
 * 看它有没有进技能清单、名字和描述有没有解析对。
 *
 * 它仍然**不是**完整会话验证：真正的端到端要看系统提示词里有没有 <available_skills>，
 * 那需要建会话（本探针不建会话，所以不花钱）。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-skills-load.ts
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { renderSkillFile, skillDirs } from '../src/main/pi-skills';

/** 顺便看一眼探针（probe-skills.ts）刚写下的真实文件长什么样 */
const SAMPLE_PATHS = [
  path.join(process.env.TEMP ?? '', 'si-probe-root', 'skills-pending', 'probe-water-helper.md'),
];

async function main(): Promise<void> {
  const { DefaultResourceLoader } = await import('@earendil-works/pi-coding-agent');
  const skillsRoot = await mkdtemp(path.join(os.tmpdir(), 'si-probe-load-'));
  const { enabledDir } = skillDirs(skillsRoot);
  await mkdir(enabledDir, { recursive: true });

  // 用渲染函数生成两个技能，其中一个故意带"容易被 YAML 吃掉"的字符
  const cases: Array<{ file: string; expectName: string }> = [
    {
      file: 'water-helper.md',
      expectName: 'water-helper',
    },
    {
      file: 'Quirk_Name.md',
      expectName: 'quirk-name', // 白名单允许大写/下划线，写进 frontmatter 时必须转成规范形式
    },
  ];
  await writeFile(
    path.join(enabledDir, 'water-helper.md'),
    renderSkillFile({
      name: 'water-helper',
      description: '提醒主人喝水。当主人长时间没喝水、或者提到喝水时使用。',
      body: '# 喝水提醒\n\n起来接杯水，200ml。',
    }),
    'utf8',
  );
  await writeFile(
    path.join(enabledDir, 'Quirk_Name.md'),
    renderSkillFile({
      name: 'Quirk_Name',
      description: '带冒号: 和 #井号 的描述，用来确认 YAML 块标量没被特殊字符搞坏',
      body: '正文里有一行 --- 这样的分隔线，不能被当成 frontmatter 结束。\n\n---\n\n后面还有内容。',
    }),
    'utf8',
  );

  // 和 pi-engine.ts 一模一样的接法：additionalSkillPaths 指向 <root>/skills
  const loader = new DefaultResourceLoader({
    cwd: skillsRoot,
    agentDir: path.join(skillsRoot, 'pi-agent'),
    noExtensions: true,
    additionalSkillPaths: [enabledDir],
  });
  await loader.reload();

  const skills = loader.getSkills().skills;
  console.log('pi 扫到的技能：');
  for (const skill of skills) {
    console.log(`  · name=${skill.name}`);
    console.log(`    description=${skill.description}`);
    console.log(`    file=${skill.filePath}`);
  }

  let ok = true;
  for (const item of cases) {
    const found = skills.find((skill) => skill.filePath.endsWith(item.file));
    if (!found) {
      console.log(`❌ pi 没扫到 ${item.file}（生成格式或路径有问题）`);
      ok = false;
      continue;
    }
    if (found.name !== item.expectName) {
      console.log(`❌ ${item.file} 的 name 解析成了 ${found.name}，期望 ${item.expectName}`);
      ok = false;
      continue;
    }
    if (!found.description.trim()) {
      console.log(`❌ ${item.file} 没有 description（pi 会拒绝加载这种技能）`);
      ok = false;
      continue;
    }
    console.log(`✅ ${item.file} → pi 加载成功（name=${found.name}）`);
  }

  // 顺手说说探针留下的真实文件（如果还在）
  for (const sample of SAMPLE_PATHS) {
    try {
      const raw = await readFile(sample, 'utf8');
      console.log(`\n(参考) probe-skills.ts 写下的文件仍在：${sample}（${raw.length} 字节）`);
    } catch {
      // 没留下就算了
    }
  }

  await rm(skillsRoot, { recursive: true, force: true });
  console.log('\n临时技能目录已删除');
  if (!ok) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
