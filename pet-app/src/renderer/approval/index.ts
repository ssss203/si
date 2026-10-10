/**
 * 授权门小窗（阶段 F）的渲染层。
 *
 * 它只做三件事：把主进程递过来的"这一问"画出来、画倒计时、把主人的选择回给主进程。
 * 判定逻辑全在主进程（pi-approval.ts）—— 渲染层不碰磁盘、不决定放行。
 *
 * 为什么要主动拉一次 current()：
 *   窗口是**第一次真的要问**的时候才建的，`loadURL` 是异步的。如果只靠主进程
 *   `webContents.send('approval:request')`，第一问很可能在监听器挂上之前就发出去了。
 *   所以启动时用 invoke 拉一次（invoke 一定在渲染层就绪之后才被处理），
 *   两边的数据都带 id，重复画同一问是幂等的。
 */
import spec from '../../../pet-spec.json';
import type { ApprovalDecision, ApprovalRequestView, PetSpec } from '../../shared/contracts';
import './index.css';

const petSpec = spec as PetSpec;

// 主题色：和别的窗口一样从 pet-spec.json 读
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);
document.title = `${petSpec.character.displayName}想问你一件事`;

const toolNameEl = document.getElementById('tool-name') as HTMLSpanElement;
const pathEl = document.getElementById('target-path') as HTMLSpanElement;
const dirEl = document.getElementById('target-dir') as HTMLDivElement;
const hintEl = document.getElementById('hint') as HTMLDivElement;
const countdownEl = document.getElementById('countdown') as HTMLDivElement;
const onceBtn = document.getElementById('btn-once') as HTMLButtonElement;
const dirBtn = document.getElementById('btn-dir') as HTMLButtonElement;
const denyBtn = document.getElementById('btn-deny') as HTMLButtonElement;

/** 当前画着的那一问；id 对不上就不重画（幂等） */
let shown: ApprovalRequestView | null = null;
/** 主人已经点过了，别再响应（防止连点发两次答复） */
let answered = false;
let tickTimer: number | undefined;

/** 删掉"路径里那层多余的引号"，免得主人看到 `"C:\x"` 这种带引号的东西 */
function cleanPath(value: string): string {
  return value.replace(/^"+|"+$/g, '');
}

function stopTicking(): void {
  if (tickTimer !== undefined) {
    window.clearInterval(tickTimer);
    tickTimer = undefined;
  }
}

/** 剩多少秒（负数按 0 算） */
function secondsLeft(request: ApprovalRequestView): number {
  const due = Date.parse(request.expiresAt);
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.ceil((due - Date.now()) / 1000));
}

function paintCountdown(): void {
  if (!shown) return;
  const left = secondsLeft(shown);
  if (left <= 0) {
    countdownEl.textContent = '⏱ 已超时 —— 按「拒绝」处理了';
    countdownEl.classList.add('expired');
    stopTicking();
    return;
  }
  countdownEl.textContent = `⏱ 还剩 ${left} 秒，不操作就当拒绝`;
}

function disableButtons(): void {
  onceBtn.disabled = true;
  dirBtn.disabled = true;
  denyBtn.disabled = true;
}

/** 画一问（同一 id 重复调用是幂等的） */
function render(request: ApprovalRequestView): void {
  if (shown && shown.id === request.id) return;
  shown = request;
  answered = false;

  toolNameEl.textContent = request.toolName;
  pathEl.textContent = cleanPath(request.path);
  pathEl.title = request.path;
  dirEl.textContent = `所在目录：${cleanPath(request.dir)}`;
  hintEl.textContent = `肆想改这个文件，它在你项目目录之外。选「这个目录以后都允许」之后，${cleanPath(request.dir)} 里的文件就不再问了（可以在「${petSpec.character.displayName}的小屋 → 🔓 已授权目录」里撤销）。`;
  onceBtn.disabled = false;
  dirBtn.disabled = false;
  denyBtn.disabled = false;

  stopTicking();
  paintCountdown();
  tickTimer = window.setInterval(paintCountdown, 250);
}

/** 主人点了按钮：回给主进程，然后等主进程关窗 */
function answer(decision: ApprovalDecision): void {
  if (!shown || answered) return;
  answered = true;
  stopTicking();
  disableButtons();
  const id = shown.id;
  void window.petAPI?.approval.respond({ id, decision }).then(
    (accepted) => {
      countdownEl.textContent = accepted === false ? '这一问已经结束了（超时或已被处理）' : '已回复，肆继续干活';
    },
    () => {
      countdownEl.textContent = '回复失败：主进程没接住（窗口里的按钮不会直接改任何文件）';
    },
  );
}

onceBtn.addEventListener('click', () => answer('once'));
dirBtn.addEventListener('click', () => answer('dir'));
denyBtn.addEventListener('click', () => answer('deny'));

// Esc = 拒绝（最保守的那个选择，符合"没想好就别放行"）
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') answer('deny');
});

// 主进程的新一问
window.petAPI?.approval.onRequest(render);

// 启动时主动拉一次：第一问很可能比监听器先到
void window.petAPI?.approval.current().then(
  (request) => {
    if (request) render(request);
  },
  () => {
    // 拉不到就等事件，不是错误
  },
);
