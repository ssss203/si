/**
 * pi-skills.ts —— 「技能」工具（功能 B）：让肆自己写技能，但**必须主人批准才生效**。
 *
 * ── 安全模型：默认什么都不加载 ────────────────────────────────────────────────
 *   · pi 只扫 <petRoot>/skills/                （已启用，pi-engine.ts 里 additionalSkillPaths 接的就是它）
 *   · 肆只能往 <petRoot>/skills-pending/ 写     （待批准，pi 根本不看这个目录）
 *   · 主人点「启用」= 把文件从 skills-pending 移到 skills，下次建会话才被 pi 扫到
 *   也就是说：肆写下的技能**在被批准之前对模型完全不可见**，它没法靠写技能给自己
 *   偷偷加一段新的行为指令。加上 noExtensions: true，磁盘上也不存在能自动加载的扩展。
 *
 * ── 官方技能格式（读自 pi-coding-agent 的 docs/skills.md + dist/core/skills.js）──
 *   Agent Skills 规范：一个技能是一个**含 SKILL.md 的目录**（可带 references/ scripts/）。
 *   pi 同时接受「独立的 .md 文件」（dist/core/skills.js 的 loadSkillFromFile：非 SKILL.md
 *   的文件只有带非空 description 才会被加载），本模块就生成这种单文件形式：
 *
 *     ---
 *     name: water-helper
 *     description: 提醒主人喝水。当主人长时间没喝水或主动提到喝水时使用。
 *     ---
 *
 *     （正文：给模型的指令，也就是 body）
 *
 *   字段规则（照抄官方）：
 *     · frontmatter 必须以 `---` 开头，以单独一行的 `---` 结束；值是 YAML
 *       （pi 用 yaml.parse 解析，所以我们写正文时一律用块标量 `|`，避免特殊字符炸 YAML）
 *     · name        必填（我们总是写），规范限制小写字母/数字/连字符，≤64 字符，
 *                   不能以连字符开头结尾、不能有连续连字符。pi 的名字校验只产 warning
 *                   不拦加载，但**不合规的名字没有意义**（/skill:name 敲不出来），
 *                   所以写文件时统一转成小写连字符形式（见 toSkillFrontmatterName）。
 *     · description 必填，≤1024 字符。**没有 description 的技能 pi 直接不加载**，
 *                   而且模型是靠它决定"什么时候该用这个技能"的，所以必须写清楚。
 *     · 可选：license / compatibility / metadata / allowed-tools / disable-model-invocation
 *   正文里引用附带文件要用相对技能目录的路径（本模块的单文件技能没有附带文件）。
 *
 * ⚠️ 老规矩（和 pi-tools.ts 一样）：pi 和 typebox 都是纯 ESM，**值导入必须用动态 import()**
 * （工厂函数允许 async），静态导入只留 `import type`（编译期擦除）。
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SkillInfo } from '../shared/contracts';

/**
 * 技能名的白名单正则：只允许字母数字开头，后面跟字母数字、下划线、连字符，总长 ≤41。
 * 这是**防路径穿越的第一道门**：`..`、`/`、`\`、空格、盘符、ADS 冒号全都不在字符集里，
 * 所以 `<name>.md` 拼进目录之后不可能跑到目录外面去（main.ts 的 IPC handler 用同一个正则）。
 */
export const SKILL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/;

/** 官方规范的 description 上限 */
const MAX_DESCRIPTION_LENGTH = 1024;

/** 官方规范的 name 上限（转换后仍超长就直接失败，不写半成品） */
const MAX_FRONTMATTER_NAME_LENGTH = 64;

/** 待批准目录名（pi 不扫它）/ 已启用目录名（pi 只扫它） */
export const PENDING_DIR_NAME = 'skills-pending';
export const ENABLED_DIR_NAME = 'skills';

/** 走白名单正则 + 长度检查；不通过就抛错（调用方不用再判一次） */
export function assertSkillName(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_NAME_PATTERN.test(value)) {
    throw new Error('技能名只能用小写/大写字母、数字、下划线、连字符，且以字母数字开头（最长 41 字符）');
  }
  return value;
}

/** 已启用 / 待批准两个目录的绝对路径（只在一处拼，避免两边写法漂移） */
export function skillDirs(skillsRoot: string): { enabledDir: string; pendingDir: string } {
  return {
    enabledDir: path.join(skillsRoot, ENABLED_DIR_NAME),
    pendingDir: path.join(skillsRoot, PENDING_DIR_NAME),
  };
}

/**
 * 把白名单里的名字转成官方规范允许的 frontmatter name：
 * 小写化 + 下划线换连字符 + 合并/去掉首尾连字符。
 * 白名单字符集是规范字符集的超集，所以转换后必然合法 —— 转换的意义在于
 * 让 /skill:name 这样的命令名可用（大写和下划线在规范里是无效字符）。
 */
function toSkillFrontmatterName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length === 0 || normalized.length > MAX_FRONTMATTER_NAME_LENGTH) {
    throw new Error(`技能名转换成官方格式后不可用：${name}`);
  }
  return normalized;
}

/**
 * 一个 YAML 块标量（`|`）能安全承载的正文：
 * 去掉 CR（统一成 LF）、拿掉 BOM、掐掉结尾空白、把行尾空格删掉（避免 YAML 折叠歧义）。
 * 块标量里唯一需要小心的就是"某一行恰好是 `---`"—— 那会被 frontmatter 解析器
 * 当成结束标记。这里做行首缩进保护（技能正文本来就是 Markdown，缩进两格无害）。
 */
function toBlockScalarBody(text: string): string {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  return lines.map((line) => (line.trim() === '---' ? `  ${line}` : line)).join('\n');
}

/** 按官方格式渲染一个技能文件（frontmatter + 正文），注释见文件头 */
export function renderSkillFile(options: { name: string; description: string; body: string }): string {
  const frontmatterName = toSkillFrontmatterName(options.name);
  const description = toBlockScalarBody(options.description);
  const body = toBlockScalarBody(options.body);
  return [
    '---',
    `name: ${frontmatterName}`,
    'description: |',
    ...description.split('\n').map((line) => (line.length > 0 ? `  ${line}` : '')),
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * 极简 frontmatter 读取（只认我们自己写出来的 `key: value` 与 `key: |` 块标量）。
 * 为什么不用 yaml 库：那要再引一个依赖，而这里只需要两个字段，
 * 且 pi 的格式是我们自己生成的 —— 保持解析面最小反而是安全优势。
 */
export function parseSkillFile(text: string): { name: string; description: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const result = { name: '', description: '' };
  if (!normalized.startsWith('---')) return result;
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return result;

  const lines = normalized.slice(4, endIndex).split('\n');
  let blockKey: 'name' | 'description' | undefined;
  const blockLines: string[] = [];

  const flush = (): void => {
    if (!blockKey) return;
    // description 是块标量：把缩进还原成段落文本
    result[blockKey] = blockLines
      .map((line) => line.replace(/^ {1,2}/, ''))
      .join('\n')
      .trim();
    blockKey = undefined;
    blockLines.length = 0;
  };

  for (const line of lines) {
    if (blockKey && /^\s+\S/.test(line)) {
      blockLines.push(line);
      continue;
    }
    if (blockKey && line.trim() === '') {
      blockLines.push('');
      continue;
    }
    flush();
    const match = /^(name|description):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as 'name' | 'description';
    const rawValue = (match[2] ?? '').trim();
    if (rawValue === '|' || rawValue === '>') {
      blockKey = key;
      continue;
    }
    result[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
  }
  flush();
  return result;
}

/** 目录里所有 *.md（不递归：单文件技能是平铺的） */
async function readSkillFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => path.join(dir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // 目录还不存在 = 没有任何技能，不是错误
    return [];
  }
}

/**
 * 读一个目录里的技能清单（供 list_skills 工具 + dashboard 面板共用）。
 * 文件名（去掉 .md）优先作为名字：主人批准时按文件名移动，用文件名最不容易对不上。
 */
export async function readSkillsFromDir(dir: string): Promise<SkillInfo[]> {
  const files = await readSkillFiles(dir);
  const skills: SkillInfo[] = [];
  for (const file of files) {
    try {
      const [content, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const parsed = parseSkillFile(content);
      const baseName = path.basename(file, '.md');
      skills.push({
        name: parsed.name || baseName,
        description: parsed.description,
        path: file,
        updatedAt: info.mtime.toISOString(),
      });
    } catch {
      // 单个文件读不了就跳过，别让整个面板挂掉
    }
  }
  return skills;
}

/** 一次读出「已启用 + 待批准」（dashboard 的 skills:overview 用） */
export async function describeSkills(skillsRoot: string): Promise<{ enabled: SkillInfo[]; pending: SkillInfo[] }> {
  const { enabledDir, pendingDir } = skillDirs(skillsRoot);
  const [enabled, pending] = await Promise.all([
    readSkillsFromDir(enabledDir),
    readSkillsFromDir(pendingDir),
  ]);
  return { enabled, pending };
}

/**
 * 批准 / 停用共用的移动逻辑：`待批准 ⇄ 已启用`。
 *
 * 为什么放在这个文件里而不是 main.ts 的 IPC handler 里：这段逻辑
 * （建目录、白名单校验、防覆盖、防穿越）是安全相关的，理应能被探针直接测，
 * 而不是只能靠启动整个 Electron 主进程来验。main.ts 只负责挡发送者 + 重建会话。
 *
 * 名字已经过白名单正则，所以拼出来的路径不可能跑出这两个目录。
 */
export async function moveSkillFile(
  skillsRoot: string,
  name: string,
  direction: 'approve' | 'disable',
): Promise<void> {
  const skill = assertSkillName(name);
  const { enabledDir, pendingDir } = skillDirs(skillsRoot);
  const fromDir = direction === 'approve' ? pendingDir : enabledDir;
  const toDir = direction === 'approve' ? enabledDir : pendingDir;
  const from = path.join(fromDir, `${skill}.md`);
  const to = path.join(toDir, `${skill}.md`);

  await mkdir(toDir, { recursive: true });
  if (await exists(to)) {
    // 不静默覆盖：目标目录里已有一份就是需要人来看一眼的状态
    throw new Error(`${direction === 'approve' ? '已启用' : '待批准'}目录里已经有一份 ${skill}.md，先处理它`);
  }
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`找不到技能文件：${from}`);
    }
    throw error;
  }
}

/** 删除技能文件：两个目录都试，返回是否真的删掉了一个 */
export async function removeSkillFile(skillsRoot: string, name: string): Promise<boolean> {
  const skill = assertSkillName(name);
  const { enabledDir, pendingDir } = skillDirs(skillsRoot);
  let removed = false;
  for (const dir of [enabledDir, pendingDir]) {
    const file = path.join(dir, `${skill}.md`);
    if (await exists(file)) {
      await rm(file, { force: true });
      removed = true;
    }
  }
  return removed;
}

/** 文件在不在（用 stat 而不是 access：目录也算"存在"，我们不希望误判） */
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** 技能正文的长度上限：技能是给模型看的指令，太长会白烧上下文 */
const MAX_BODY_LENGTH = 20000;

/** 技能工具的结果详情（显式声明，否则联合返回会把 details 推断成"精确到 undefined"）
 *  注意不要叫 SkillDetails：那是 pi 类型里的名字，重名会让人误解成官方类型。 */
interface SkillToolDetails {
  ok: boolean;
  /** 成功时有：技能名 / 落盘路径 */
  name?: string;
  path?: string;
}

export function createSkillsExtension(options: {
  cwd: string;
  skillsRoot: string;
}): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI): Promise<void> => {
    // 动态导入 ESM-only 的包（原因见文件头）
    const { defineTool } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');
    const { enabledDir, pendingDir } = skillDirs(options.skillsRoot);

    const createSkill = defineTool<ReturnType<typeof Type.Object>, SkillToolDetails>({
      name: 'create_skill',
      label: '写一个技能',
      description:
        '把一个可复用的做事方法写成技能，提交给主人批准。'
        + 'name 只能用小写/大写字母、数字、下划线、连字符（例：water-helper）；'
        + 'description 要写清"这个技能做什么 + 什么时候该用它"（模型靠它决定要不要加载）；'
        + 'body 是给未来的自己看的 Markdown 指令正文。'
        + '提交后**不会立刻生效**，要等主人在"桌宠小屋 → 技能与工具"里点启用。',
      parameters: Type.Object({
        name: Type.String({ description: '技能名，例：water-helper' }),
        description: Type.String({ description: '一句话说明：做什么 + 什么时候用' }),
        body: Type.String({ description: '技能正文（Markdown）' }),
      }),
      async execute(_toolCallId, params) {
        try {
          const name = assertSkillName(String(params.name));
          const description = String(params.description).trim();
          const body = String(params.body).trim();
          if (description.length === 0) {
            return { content: [{ type: 'text', text: '❌ description 不能为空 —— 没有描述的技能 pi 根本不会加载。' }], details: { ok: false } };
          }
          if (description.length > MAX_DESCRIPTION_LENGTH) {
            return {
              content: [{ type: 'text', text: `❌ description 太长了（${description.length} 字，官方上限 ${MAX_DESCRIPTION_LENGTH}）。把它压成"做什么 + 什么时候用"。` }],
              details: { ok: false },
            };
          }
          if (body.length === 0) {
            return { content: [{ type: 'text', text: '❌ body 不能为空 —— 技能正文就是你要教给未来的自己的东西。' }], details: { ok: false } };
          }
          if (body.length > MAX_BODY_LENGTH) {
            return {
              content: [{ type: 'text', text: `❌ body 太长了（${body.length} 字，上限 ${MAX_BODY_LENGTH}）。拆成更小的技能，或者只留下真正必要的步骤。` }],
              details: { ok: false },
            };
          }

          await mkdir(pendingDir, { recursive: true });
          const target = path.join(pendingDir, `${name}.md`);
          // 已启用目录里同名 = 已经在生效，不让它悄悄覆盖主人的现役技能
          const enabledNames = (await readSkillFiles(enabledDir)).map((file) => path.basename(file, '.md'));
          if (enabledNames.includes(name)) {
            return {
              content: [{ type: 'text', text: `⚠️ 已经有一个启用中的技能叫 ${name}。换个名字，或者让主人在面板里先停用它。` }],
              details: { ok: false },
            };
          }
          const existed = (await readSkillFiles(pendingDir)).some((file) => path.basename(file, '.md') === name);
          await writeFile(target, renderSkillFile({ name, description, body }), 'utf8');

          return {
            content: [{
              type: 'text',
              text: `${existed ? '已更新' : '已提交'}技能「${name}」，等主人在"桌宠小屋 → 技能与工具"面板里启用。`
                + `\n文件：${target}`
                + '\n（在批准之前，它不会进入你的技能列表，也不会影响你的行为。）',
            }],
            details: { ok: true, name, path: target },
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: `❌ 技能没写成：${message}` }], details: { ok: false } };
        }
      },
    });

    const listSkills = defineTool({
      name: 'list_skills',
      label: '看我有哪些技能',
      description:
        '列出你现在真正会用的技能（已启用）和写好但还没被主人批准的技能（待批准）。'
        + '写新技能之前先调它一次，避免重复造轮子。',
      parameters: Type.Object({}),
      async execute() {
        const { enabled, pending } = await describeSkills(options.skillsRoot);
        const format = (items: SkillInfo[]): string => items.length === 0
          ? '（空）'
          : items.map((item) => `· ${item.name} —— ${item.description || '(没有描述)'}`).join('\n');
        return {
          content: [{
            type: 'text',
            text: `已启用（${enabled.length}，这些才会影响你的行为）：\n${format(enabled)}`
              + `\n\n待批准（${pending.length}，主人还没点头，你现在用不了）：\n${format(pending)}`,
          }],
          details: { enabled: enabled.length, pending: pending.length },
        };
      },
    });

    pi.registerTool(createSkill);
    pi.registerTool(listSkills);
  };
}
