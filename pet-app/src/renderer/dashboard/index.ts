import spec from '../../../pet-spec.json';
import type { PetSpec, PetStats, Settings, SkillInfo, SkillsOverview, InteractionSpec } from '../../shared/contracts';
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
}

init();


// 面板自动刷新：肆写完技能后，不用重启桌宠也能在面板里看到。
// 主进程只在窗口创建时喂一次数据，所以这里定时刷 + 窗口重新聚焦时刷。
// 开销可以忽略：技能目录就是两个小文件夹。
window.addEventListener('focus', () => {
  void loadSkills();
});
setInterval(() => {
  void loadSkills();
}, 5000);