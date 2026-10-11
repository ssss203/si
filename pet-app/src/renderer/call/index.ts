import spec from '../../../pet-spec.json';
import type { CallEvent, ChatConfig, PetSpec, UpdateState } from '../../shared/contracts';
import './index.css';

const petSpec = spec as PetSpec;

// 应用主题色
const theme = petSpec.experience.theme;
document.documentElement.style.setProperty('--primary', theme.primary);
document.documentElement.style.setProperty('--accent', theme.accent);
document.documentElement.style.setProperty('--background', theme.background);
document.documentElement.style.setProperty('--surface', theme.surface);
document.documentElement.style.setProperty('--text', theme.text);
document.documentElement.style.setProperty('--muted', theme.muted);
document.documentElement.style.setProperty('--radius', `${theme.cornerRadius}px`);
document.title = `${petSpec.character.displayName}的通话`;

const messagesEl = document.getElementById('messages') as HTMLDivElement;
const inputEl = document.getElementById('chat-input') as HTMLInputElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const statusDot = document.getElementById('status-dot') as HTMLDivElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const configPanel = document.getElementById('config-panel') as HTMLDivElement;
const settingsToggle = document.getElementById('settings-toggle') as HTMLButtonElement;
const closeBtn = document.getElementById('close-btn') as HTMLButtonElement;
const newChatBtn = document.getElementById('new-chat-btn') as HTMLButtonElement;
const revertBtn = document.getElementById('revert-btn') as HTMLButtonElement;
const sizeSwitch = document.getElementById('size-switch') as HTMLDivElement;
const dsKeyInput = document.getElementById('ds-key') as HTMLInputElement;
const dsModelSelect = document.getElementById('ds-model') as HTMLSelectElement;
const ttsToggle = document.getElementById('toggle-tts') as HTMLDivElement;
const aiBubbleToggle = document.getElementById('toggle-aibubble') as HTMLDivElement;
const proactiveToggle = document.getElementById('toggle-proactive') as HTMLDivElement;
const companionToggle = document.getElementById('toggle-companion') as HTMLDivElement;
const updateCheckToggle = document.getElementById('toggle-update-check') as HTMLDivElement;
const updateBanner = document.getElementById('update-banner') as HTMLDivElement;
const updateText = document.getElementById('update-text') as HTMLSpanElement;
const updateDownloadBtn = document.getElementById('update-download-btn') as HTMLButtonElement;
const saveConfigBtn = document.getElementById('save-config') as HTMLButtonElement;
const saveHint = document.getElementById('save-hint') as HTMLSpanElement;

let config: ChatConfig = {
  deepseekApiKey: '',
  deepseekModel: 'deepseek-chat',
  ttsEnabled: true,
  aiBubbles: false,
  proactiveActions: true,
  // 陪伴感知默认关闭（opt-in）—— 渲染层的初值必须和主进程 defaultChatConfig 一致，
  // 否则"还没加载完就显示成开着"会误导主人。
  companionAwareness: false,
  // 检查更新默认开启（不涉及隐私，只发一个匿名请求）
  checkUpdates: true,
};
let busy = false;
let currentReply = '';

// ===== 聊天记录持久化：数组=真值，localStorage=镜像，DOM=投影 =====
type ChatRole = 'user' | 'assistant' | 'thinking' | 'error';
type ChatMessage = { role: ChatRole; text: string };
const HISTORY_KEY = 'si-chat-history';
const MAX_HISTORY = 100;

let messages: ChatMessage[] = [];   // 内存真值

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

// ① 唯一写入口：数组 → localStorage
function persist(): void {
  if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(messages));
}

// ② 唯一渲染：数组 → DOM
function render(): void {
  messagesEl.replaceChildren();
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '和肆说点什么吧';
    messagesEl.appendChild(empty);
  } else {
    for (const m of messages) {
      const el = document.createElement('div');
      el.className = `msg ${m.role}`;
      el.textContent = m.text;
      messagesEl.appendChild(el);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ③ 追加完整消息（用户消息）
function pushMessage(role: ChatRole, text: string): void {
  if (role === 'error') return;   // 错误不存
  messages.push({ role, text });
  persist();
  render();
}

// ④ 流式更新最后一条 AI 回复（只改最后一条，不会新增）
function updateLastMessage(text: string): void {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    last.text = text;
  } else {
    messages.push({ role: 'assistant', text });
  }
  persist();
  // 流式高频更新：只改最后一条 DOM 文本，避免整表重建闪烁
  const lastEl = messagesEl.lastElementChild;
  if (lastEl && lastEl.classList.contains('assistant')) {
    lastEl.textContent = text;
  } else {
    render();
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ⑤ 清空
function clearChat(): void {
  messages = [];
  localStorage.removeItem(HISTORY_KEY);
  render();
}

function setStatus(status: 'idle' | 'thinking' | 'speaking' | 'error'): void {
  statusDot.className = `status-dot ${status}`;
  const labels: Record<string, string> = {
    idle: '通话',
    thinking: '肆 思考中…',
    speaking: '肆 说话中…',
    error: '出错',
  };
  statusText.textContent = labels[status] ?? '通话';
}

// 仅用于错误提示（不持久化）；正常消息一律走 pushMessage / updateLastMessage
function addMessage(role: 'user' | 'assistant' | 'error' | 'thinking', text: string): void {
  const empty = messagesEl.querySelector('.empty-hint');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return;
}

function speak(text: string): void {
  if (!config.ttsEnabled) return;
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.05;
    synth.speak(utterance);
  } catch {
    // TTS is best-effort; failure must not break the call.
  }
}


async function loadConfig(): Promise<void> {
  try {
    config = await window.petAPI?.call.getConfig() ?? config;
    dsKeyInput.value = config.deepseekApiKey;
    dsModelSelect.value = config.deepseekModel;
    ttsToggle.classList.toggle('active', config.ttsEnabled);
    aiBubbleToggle.classList.toggle('active', config.aiBubbles);
    proactiveToggle.classList.toggle('active', config.proactiveActions);
    companionToggle.classList.toggle('active', config.companionAwareness);
    updateCheckToggle.classList.toggle('active', config.checkUpdates);
  } catch (error) {
    console.error('Failed to load call config:', error);
  }
}

async function saveConfig(): Promise<void> {
  try {
    config = await window.petAPI?.call.saveConfig({
      deepseekApiKey: dsKeyInput.value.trim(),
      deepseekModel: dsModelSelect.value,
      ttsEnabled: config.ttsEnabled,
      aiBubbles: config.aiBubbles,
      proactiveActions: config.proactiveActions,
      companionAwareness: config.companionAwareness,
      checkUpdates: config.checkUpdates,
    }) ?? config;
    saveHint.textContent = '已保存 ✓';
    saveHint.className = 'save-hint ok';
  } catch (error) {
    saveHint.textContent = error instanceof Error ? error.message : '保存失败';
    saveHint.className = 'save-hint bad';
  }
  setTimeout(() => { saveHint.textContent = ''; saveHint.className = 'save-hint'; }, 2500);
}

async function sendMessage(): Promise<void> {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  busy = true;
  inputEl.value = '';
  sendBtn.disabled = true;
  pushMessage('user', text);
  currentReply = '';
  setStatus('thinking');
  try {
    await window.petAPI?.call.send(text);
  } catch (error) {
    addMessage('error', error instanceof Error ? error.message : String(error));
    setStatus('error');
    busy = false;
    sendBtn.disabled = false;
  }
}

// 事件订阅：流式回复
window.petAPI?.call.onEvent((event: CallEvent) => {
  if (event.kind === 'status') {
    setStatus(event.status);
  } else if (event.kind === 'delta') {
    currentReply += event.text;
    updateLastMessage(currentReply);
  } else if (event.kind === 'reply') {
    updateLastMessage(event.text);
    if (event.text) speak(event.text);
    busy = false;
    sendBtn.disabled = false;
    inputEl.focus();
  } else if (event.kind === 'error') {
    addMessage('error', event.message);
    busy = false;
    sendBtn.disabled = false;
  }
});

sendBtn.addEventListener('click', () => void sendMessage());
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
});
closeBtn.addEventListener('click', () => void window.petAPI?.window.hideCall());
settingsToggle.addEventListener('click', () => {
  configPanel.hidden = !configPanel.hidden;
});

// 新建对话：清空上下文 + 清空界面消息
// 撤回按钮：把肆最近的改动回滚到它动手之前的存档
// （只还原它动过的那几个文件：git checkout <快照> -- <paths>；不碰用户其它未提交改动）
revertBtn.addEventListener('click', async () => {
  revertBtn.disabled = true;
  try {
    const result = await window.petAPI?.engine.revert();
    if (!result) {
      addMessage('error', '撤回失败：主进程没有回应');
      return;
    }
    addMessage(result.ok ? 'thinking' : 'error', `↩️ ${result.message}`);
  } catch (error) {
    addMessage('error', `撤回失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    revertBtn.disabled = false;
  }
});

newChatBtn.addEventListener('click', async () => {
  if (busy) {
    await window.petAPI?.call.stop();
    busy = false;
    sendBtn.disabled = false;
  }
  try {
    await window.petAPI?.call.clear();
    clearChat();
    currentReply = '';
    setStatus('idle');
    inputEl.focus();
  } catch (error) {
    console.error('Failed to clear chat:', error);
  }
});

// 切换窗口大小：三档明确按钮
const CALL_SIZES: Array<[number, number]> = [
  [400, 560],
  [460, 640],
  [600, 760],
];
sizeSwitch.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('size-btn')) return;
  const index = Number(target.dataset.size ?? '1');
  const [w, h] = CALL_SIZES[index] ?? CALL_SIZES[1]!;
  sizeSwitch.querySelectorAll('.size-btn').forEach((btn) => btn.classList.remove('active'));
  target.classList.add('active');
  void window.petAPI?.call.resize(w, h);
});
ttsToggle.addEventListener('click', () => {
  config.ttsEnabled = !config.ttsEnabled;
  ttsToggle.classList.toggle('active', config.ttsEnabled);
});
aiBubbleToggle.addEventListener('click', () => {
  config.aiBubbles = !config.aiBubbles;
  aiBubbleToggle.classList.toggle('active', config.aiBubbles);
});
// 主动行为开关：保存时 main.ts 会重建 pi 会话，否则关掉了工具还在（扩展是建会话时注册的）
proactiveToggle.addEventListener('click', () => {
  config.proactiveActions = !config.proactiveActions;
  proactiveToggle.classList.toggle('active', config.proactiveActions);
});
// 陪伴感知开关：同样要重建会话（'context' 注入扩展是建会话时注册的），
// 另外主进程会跟着起/停采样定时器 —— 关掉就是真的不采样。
companionToggle.addEventListener('click', () => {
  config.companionAwareness = !config.companionAwareness;
  companionToggle.classList.toggle('active', config.companionAwareness);
});
// 检查更新开关：不用重建 pi 会话（和模型无关），只影响下次启动那一次检查。
// 但当前这次已经查过就不再查了 —— 关掉它不会"撤回"已经弹过的提示，主人点过/关掉就不再出现。
updateCheckToggle.addEventListener('click', () => {
  config.checkUpdates = !config.checkUpdates;
  updateCheckToggle.classList.toggle('active', config.checkUpdates);
});

// ── 发现新版本：顶部那一行 ──────────────────────────────────────────────────
// 地址不在这边：点按钮只是让主进程用 shell.openExternal 打开它写死的下载页。
function renderUpdate(state: UpdateState | null): void {
  if (!state || typeof state.latestVersion !== 'string') {
    updateBanner.hidden = true;
    updateText.textContent = '';
    return;
  }
  updateText.textContent = `发现新版本 ${state.latestVersion}`;
  updateBanner.hidden = false;
}

// ① 启动时自己拉一次（主进程的检查是延迟 30 秒跑的，晚开的窗口靠这个对上）
void window.petAPI?.update.state().then(renderUpdate).catch(() => { });
// ② 之后主进程推什么就画什么
window.petAPI?.update.onState(renderUpdate);

updateDownloadBtn.addEventListener('click', async () => {
  updateDownloadBtn.disabled = true;
  try {
    await window.petAPI?.update.open();
    // 主进程打开下载页时会顺手把状态清成 null 并推一次，那一推会把这一行收起来；
    // 这里不再自己 renderUpdate(null)，免得"点没点成功"两处各说一套。
  } catch (error) {
    addMessage('error', `打开下载页失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    updateDownloadBtn.disabled = false;
  }
});

saveConfigBtn.addEventListener('click', () => void saveConfig());

async function init(): Promise<void> {
  await loadConfig();
  messages = loadHistory();
  render();
  setStatus('idle');
}

init();
