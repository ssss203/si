import spec from '../../../pet-spec.json';
import type { ApprovalDirsOverview, CompanionSnapshot, CompanionTag, PetSpec, PetStats, Settings, SkillInfo, SkillsOverview, InteractionSpec } from '../../shared/contracts';
import './index.css';

// 用于 asset link 检查的占位符（实际不需要导入所有图片）
// require.context('../../assets/pet', true, /\.png$/);

const petSpec = spec as PetSpec;
document.title = `${petSpec.character.displayName}的小屋`;

// 设置主题色
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);

// 设置宠物信息
document.getElementById('pet-name')!.textContent = petSpec.character.displayName;
document.getElementById('pet-personality')!.textContent = petSpec.character.personality.join('、');

const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const affectionEl = document.getElementById('affection') as HTMLDivElement;
const moodEl = document.getElementById('mood') as HTMLDivElement;
const todayInteractionsEl = document.getElementById('today-interactions') as HTMLDivElement;
const companionMinutesEl = document.getElementById('companion-minutes') as HTMLDivElement;
const interactionsList = document.getElementById('interactions-list') as HTMLDivElement;
const toggleAlwaysOnTop = document.getElementById('toggle-always-on-top') as HTMLDivElement;
const toggleClickThrough = document.getElementById('toggle-click-through') as HTMLDivElement;
const sizeSelector = document.getElementById('size-selector') as HTMLDivElement;
const skillsEnabledEl = document.getElementById('skills-enabled') as HTMLDivElement;
const skillsPendingEl = document.getElementById('skills-pending') as HTMLDivElement;
const skillsToolsEl = document.getElementById('skills-tools') as HTMLDivElement;
const approvalDirsEl = document.getElementById('approval-dirs') as HTMLDivElement;
const companionStatusEl = document.getElementById('companion-status') as HTMLDivElement;
const companionActivitiesEl = document.getElementById('companion-activities') as HTMLDivElement;
const companionClearBtn = document.getElementById('companion-clear') as HTMLButtonElement;

let currentSettings: Settings | null = null;

// 加载互动列表
async function loadInteractions(): Promise<void> {
  try {
    const interactions = await window.petAPI?.interactions.list();
    if (!interactions) return;

    interactionsList.replaceChildren();
    for (const interaction of interactions) {
      const btn = document.createElement('button');
      btn.className = 'interaction-btn';
      const emoji = document.createElement('span');
      emoji.textContent = interaction.emoji;
      const label = document.createElement('span');
      label.textContent = interaction.label;
      btn.append(emoji, label);
      btn.addEventListener('click', async () => {
        try {
          await window.petAPI?.interactions.trigger(interaction.id);
        } catch (error) {
          console.error('Failed to trigger interaction:', error);
        }
      });
      interactionsList.appendChild(btn);
    }
  } catch (error) {
    console.error('Failed to load interactions:', error);
  }
}

// 加载设置
async function loadSettings(): Promise<void> {
  try {
    const settings = await window.petAPI?.settings.get();
    if (!settings) return;
    currentSettings = settings;

    // 更新开关状态
    if (settings.alwaysOnTop) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }

    if (settings.clickThrough) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }

    // 更新大小选择
    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => {
      const scale = parseFloat((btn as HTMLElement).dataset.scale || '1');
      if (Math.abs(scale - settings.petScale) < 0.01) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  } catch (error) {
    console.error('Failed to load settings:', error);
  }
}

// 加载统计数据
async function loadStats(): Promise<void> {
  try {
    const stats = await window.petAPI?.interactions.stats();
    if (!stats) return;
    updateStats(stats);
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

function updateStats(stats: PetStats): void {
  affectionEl.textContent = String(stats.affection);
  moodEl.textContent = String(stats.mood);
  todayInteractionsEl.textContent = String(stats.todayInteractions);
  const unit = document.createElement('small');
  unit.textContent = '分钟';
  companionMinutesEl.replaceChildren(String(stats.companionMinutes), unit);
}

// ===== 技能与工具（功能 B）=====
// 三段：已启用（每行 [停用] [删除]）、待批准（显示它自己写的说明 + [启用] [删除]）、
// 以及它现在能用的工具（只读）。所有按钮都通过主进程改文件 —— 渲染层不碰磁盘。
// 三处改动（批准/停用/删除）都会让主进程重建 pi 会话，所以技能立刻生效/失效。

/** 加一个空态灰字 */
function appendEmpty(container: HTMLDivElement, text: string): void {
  const el = document.createElement('div');
  el.className = 'skill-empty';
  el.textContent = text;
  container.appendChild(el);
}

/** 建一个小按钮（沿用 .size-btn / .skill-btn 的样式） */
function skillButton(label: string, danger: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = danger ? 'skill-btn danger' : 'skill-btn';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

/** 渲染一行技能 */
function skillRow(skill: SkillInfo, actions: HTMLButtonElement[]): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'skill-row';

  const head = document.createElement('div');
  head.className = 'skill-head';
  const name = document.createElement('div');
  name.className = 'skill-name';
  name.textContent = skill.name;
  const actionBox = document.createElement('div');
  actionBox.className = 'skill-actions';
  actionBox.append(...actions);
  head.append(name, actionBox);
  row.appendChild(head);

  // 待批准的那段显示"它自己写的说明"——主人就是靠这句话判断要不要批准
  const desc = document.createElement('div');
  desc.className = 'skill-desc';
  desc.textContent = skill.description || '(它没写说明 —— 这种技能 pi 也不会加载)';
  row.appendChild(desc);

  const file = document.createElement('div');
  file.className = 'skill-path';
  file.textContent = skill.path;
  file.title = skill.path;
  row.appendChild(file);

  return row;
}

async function renderSkills(overview: SkillsOverview): Promise<void> {
  skillsEnabledEl.replaceChildren();
  skillsPendingEl.replaceChildren();
  skillsToolsEl.replaceChildren();

  /** 三个动作共用：调主进程 → 用返回的新总览重画（不重新拉，省一次 IO） */
  const runAction = (
    action: (name: string) => Promise<SkillsOverview | undefined> | undefined,
    name: string,
  ): void => {
    void (async () => {
      try {
        const next = await action(name);
        if (next) await renderSkills(next);
      } catch (error) {
        console.error('Failed to update skills:', error);
      }
    })();
  };

  if (overview.enabled.length === 0) {
    appendEmpty(skillsEnabledEl, '还没有启用任何技能');
  } else {
    for (const skill of overview.enabled) {
      const row = skillRow(skill, [
        skillButton('停用', false, () => runAction((n) => window.petAPI?.skills.disable(n), skill.name)),
        skillButton('删除', true, () => {
          if (!window.confirm(`删除技能「${skill.name}」？文件会直接删掉。`)) return;
          runAction((n) => window.petAPI?.skills.remove(n), skill.name);
        }),
      ]);
      skillsEnabledEl.appendChild(row);
    }
  }

  if (overview.pending.length === 0) {
    appendEmpty(skillsPendingEl, '没有待批准的技能');
  } else {
    for (const skill of overview.pending) {
      const row = skillRow(skill, [
        skillButton('启用', false, () => runAction((n) => window.petAPI?.skills.approve(n), skill.name)),
        skillButton('删除', true, () => {
          if (!window.confirm(`丢弃技能「${skill.name}」？`)) return;
          runAction((n) => window.petAPI?.skills.remove(n), skill.name);
        }),
      ]);
      skillsPendingEl.appendChild(row);
    }
  }

  if (overview.tools.length === 0) {
    appendEmpty(skillsToolsEl, '它现在没有工具（工作目录没过体检，只能说话）');
  } else {
    for (const tool of overview.tools) {
      const chip = document.createElement('span');
      chip.className = 'tool-chip';
      chip.textContent = tool;
      skillsToolsEl.appendChild(chip);
    }
  }
}

async function loadSkills(): Promise<void> {
  try {
    const overview = await window.petAPI?.skills.overview();
    if (!overview) return;
    await renderSkills(overview);
  } catch (error) {
    console.error('Failed to load skills:', error);
  }
}

// ===== 已授权目录（阶段 F 的授权门）=====
// 授权小窗里选了「这个目录以后都允许」，目录就出现在这儿。
// [撤销授权] 只删 %APPDATA%\肆\allowed-dirs.json 里的那条记录（**不删任何文件**），
// 撤掉之后肆再碰这个目录，就会重新弹窗问一遍。
// 授权是整棵子树的语义，所以撤销父目录时它下面的授权条目也一起撤掉（主进程里做的）。
async function renderApprovals(overview: ApprovalDirsOverview): Promise<void> {
  approvalDirsEl.replaceChildren();

  if (overview.dirs.length === 0) {
    appendEmpty(approvalDirsEl, '还没授权任何目录 —— 它只能改项目目录里的文件');
    return;
  }

  for (const dir of overview.dirs) {
    const row = document.createElement('div');
    row.className = 'skill-row';

    const head = document.createElement('div');
    head.className = 'skill-head';
    const name = document.createElement('div');
    name.className = 'skill-name approval-dir-path';
    name.textContent = dir;
    name.title = dir;
    const actions = document.createElement('div');
    actions.className = 'skill-actions';
    actions.appendChild(skillButton('撤销授权', true, () => {
      if (!window.confirm(`撤销「${dir}」的授权？以后肆改这个目录里的文件会重新问你。`)) return;
      void (async () => {
        try {
          const next = await window.petAPI?.approval.revoke(dir);
          if (next) await renderApprovals(next);
        } catch (error) {
          console.error('Failed to revoke allowed dir:', error);
        }
      })();
    }));
    head.append(name, actions);
    row.appendChild(head);

    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    desc.textContent = '肆可以直接改这里的文件（包括子目录）';
    row.appendChild(desc);

    approvalDirsEl.appendChild(row);
  }
}

async function loadApprovals(): Promise<void> {
  try {
    const overview = await window.petAPI?.approval.list();
    if (!overview) return;
    await renderApprovals(overview);
  } catch (error) {
    console.error('Failed to load allowed dirs:', error);
  }
}

// ===== 陪伴感知（👀 肆最近看到的活动）=====
// 这个面板只有"看"和"清空"两个动作，而且**结构上就拿不到原文**：
// CompanionActivity 里只有闭集标签 + 时间戳，没有 title 字段。
// 渲染层不做任何裁剪 —— 数据在离开主进程时就已经是标签了。

/** 标签 → 人话（认不出来的标签原样显示，不去猜） */
const COMPANION_TAG_LABELS: Record<CompanionTag, string> = {
  coding: '写代码',
  'working-with-ai': '和 AI 对话',
  'reading-docs': '看文档',
  searching: '搜索',
  browsing: '上网',
  'watching-video': '看视频',
  'listening-music': '听音乐',
  chatting: '聊天',
  meeting: '开会',
  gaming: '玩游戏',
  terminal: '用终端',
  designing: '做设计',
  idle: '没在干什么',
  other: '其它',
};

/** 相对时间：只给"多久之前"，不给绝对时间戳（够用，也少一点可被回推的信息） */
function relativeTime(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`;
}

function renderCompanion(snapshot: CompanionSnapshot): void {
  companionActivitiesEl.replaceChildren();

  if (!snapshot.enabled) {
    companionClearBtn.disabled = true;
    companionStatusEl.textContent = '陪伴感知：已关闭';
    appendEmpty(companionActivitiesEl, '还没开启 —— 在通话窗口的 ⚙️ 设置里打开「让肆偶尔看看我在干嘛」之后，这里才会出现记录。关闭状态下它一次都不会去看你的窗口。');
    return;
  }

  const count = snapshot.activities.length;
  companionClearBtn.disabled = count === 0;
  companionStatusEl.textContent = snapshot.lastSampleAt === null
    ? '陪伴感知：已开启（还没采到样本）'
    : `陪伴感知：已开启 · 最近一次 ${relativeTime(snapshot.lastSampleAt)}`;

  if (count === 0) {
    appendEmpty(companionActivitiesEl, '还没有记录。开启后要等 20~45 分钟才会有第一次采样 —— 不采样的时候它是真的什么都没看。');
    return;
  }

  // 新的在最上面（和"最近看到"这个说法一致）
  for (const activity of [...snapshot.activities].reverse()) {
    const row = document.createElement('div');
    row.className = 'companion-row';

    const tag = document.createElement('span');
    tag.className = `companion-tag tag-${activity.tag}`;
    tag.textContent = activity.tag;
    tag.title = COMPANION_TAG_LABELS[activity.tag] ?? activity.tag;

    const label = document.createElement('span');
    label.className = 'companion-label';
    label.textContent = COMPANION_TAG_LABELS[activity.tag] ?? activity.tag;

    const meta = document.createElement('span');
    meta.className = 'companion-meta';
    meta.textContent = typeof activity.durationMinutes === 'number' && activity.durationMinutes > 0
      ? `${relativeTime(activity.at)} · 已持续 ${activity.durationMinutes} 分钟`
      : relativeTime(activity.at);

    row.append(tag, label, meta);
    companionActivitiesEl.appendChild(row);
  }
}

async function loadCompanion(): Promise<void> {
  try {
    const snapshot = await window.petAPI?.companion.snapshot();
    if (!snapshot) return;
    renderCompanion(snapshot);
  } catch (error) {
    console.error('Failed to load companion snapshot:', error);
  }
}

companionClearBtn.addEventListener('click', () => {
  void (async () => {
    try {
      const snapshot = await window.petAPI?.companion.clear();
      if (snapshot) renderCompanion(snapshot);
    } catch (error) {
      console.error('Failed to clear companion history:', error);
    }
  })();
});

// 关闭按钮
closeBtn.addEventListener('click', async () => {
  await window.petAPI?.window.hideDashboard();
});
// 置顶开关
toggleAlwaysOnTop.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.alwaysOnTop;
  try {
    await window.petAPI?.settings.update({ alwaysOnTop: newVal });
    currentSettings.alwaysOnTop = newVal;
    if (newVal) {
      toggleAlwaysOnTop.classList.add('active');
    } else {
      toggleAlwaysOnTop.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 鼠标穿透开关
toggleClickThrough.addEventListener('click', async () => {
  if (!currentSettings) return;
  const newVal = !currentSettings.clickThrough;
  try {
    await window.petAPI?.settings.update({ clickThrough: newVal });
    currentSettings.clickThrough = newVal;
    if (newVal) {
      toggleClickThrough.classList.add('active');
    } else {
      toggleClickThrough.classList.remove('active');
    }
  } catch (error) {
    console.error('Failed to update setting:', error);
  }
});

// 大小选择
sizeSelector.addEventListener('click', async (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  if (!currentSettings) return;

  const scale = parseFloat(target.dataset.scale || '1');
  try {
    await window.petAPI?.settings.update({ petScale: scale });
    currentSettings.petScale = scale;

    const sizeBtns = sizeSelector.querySelectorAll('.size-btn');
    sizeBtns.forEach((btn) => btn.classList.remove('active'));
    target.classList.add('active');
  } catch (error) {
    console.error('Failed to update pet scale:', error);
  }
});

// 监听统计数据更新
window.petAPI?.events.onStats((stats: PetStats) => {
  updateStats(stats);
});

// 初始化
async function init(): Promise<void> {
  await loadInteractions();
  await loadSettings();
  await loadStats();
  await loadSkills();
  await loadApprovals();
  await loadCompanion();
}

init();


// 面板自动刷新：肆写完技能后，不用重启桌宠也能在面板里看到。
// 主进程只在窗口创建时喂一次数据，所以这里定时刷 + 窗口重新聚焦时刷。
// 开销可以忽略：技能目录就是两个小文件夹，授权目录就是一个小 JSON，
// 活动历史就是内存里的十条标签。
window.addEventListener('focus', () => {
  void loadSkills();
  void loadApprovals();
  void loadCompanion();
});
setInterval(() => {
  void loadSkills();
  void loadApprovals();
  void loadCompanion();
}, 5000);