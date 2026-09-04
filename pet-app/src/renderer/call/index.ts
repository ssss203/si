import spec from '../../../pet-spec.json';
import type { CallEvent, ChatConfig, PetSpec } from '../../shared/contracts';
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
const sizeSwitch = document.getElementById('size-switch') as HTMLDivElement;
const providerDeepseekBtn = document.getElementById('provider-deepseek') as HTMLButtonElement;
const providerCozeBtn = document.getElementById('provider-coze') as HTMLButtonElement;
const blockDeepseek = document.getElementById('block-deepseek') as HTMLDivElement;
const blockCoze = document.getElementById('block-coze') as HTMLDivElement;
const tokenInput = document.getElementById('coze-token') as HTMLInputElement;
const botInput = document.getElementById('coze-bot') as HTMLInputElement;
const dsKeyInput = document.getElementById('ds-key') as HTMLInputElement;
const dsModelSelect = document.getElementById('ds-model') as HTMLSelectElement;
const ttsToggle = document.getElementById('toggle-tts') as HTMLDivElement;
const aiBubbleToggle = document.getElementById('toggle-aibubble') as HTMLDivElement;
const saveConfigBtn = document.getElementById('save-config') as HTMLButtonElement;
const saveHint = document.getElementById('save-hint') as HTMLSpanElement;

let config: ChatConfig = {
  provider: 'deepseek',
  apiToken: '',
  botId: '',
  userId: '',
  deepseekApiKey: '',
  deepseekModel: 'deepseek-chat',
  ttsEnabled: true,
  aiBubbles: false,
};
let busy = false;
let currentReply = '';

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

function applyProviderUI(): void {
  const isDeepseek = config.provider === 'deepseek';
  providerDeepseekBtn.classList.toggle('active', isDeepseek);
  providerCozeBtn.classList.toggle('active', !isDeepseek);
  blockDeepseek.hidden = !isDeepseek;
  blockCoze.hidden = isDeepseek;
}

async function loadConfig(): Promise<void> {
  try {
    config = await window.petAPI?.call.getConfig() ?? config;
    tokenInput.value = config.apiToken;
    botInput.value = config.botId;
    dsKeyInput.value = config.deepseekApiKey;
    dsModelSelect.value = config.deepseekModel;
    ttsToggle.classList.toggle('active', config.ttsEnabled);
    aiBubbleToggle.classList.toggle('active', config.aiBubbles);
    applyProviderUI();
  } catch (error) {
    console.error('Failed to load call config:', error);
  }
}

async function saveConfig(): Promise<void> {
  try {
    config = await window.petAPI?.call.saveConfig({
      provider: config.provider,
      apiToken: tokenInput.value.trim(),
      botId: botInput.value.trim(),
      deepseekApiKey: dsKeyInput.value.trim(),
      deepseekModel: dsModelSelect.value,
      ttsEnabled: config.ttsEnabled,
      aiBubbles: config.aiBubbles,
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
  addMessage('user', text);
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
    const last = messagesEl.lastElementChild;
    if (last && last.classList.contains('assistant')) {
      last.textContent = currentReply;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      addMessage('assistant', currentReply);
    }
  } else if (event.kind === 'reply') {
    const last = messagesEl.lastElementChild;
    if (!last || !last.classList.contains('assistant')) {
      addMessage('assistant', event.text);
    }
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
newChatBtn.addEventListener('click', async () => {
  if (busy) {
    await window.petAPI?.call.stop();
    busy = false;
    sendBtn.disabled = false;
  }
  try {
    await window.petAPI?.call.clear();
    messagesEl.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty-hint';
    empty.textContent = '和肆说点什么吧';
    messagesEl.appendChild(empty);
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
providerDeepseekBtn.addEventListener('click', () => {
  config.provider = 'deepseek';
  applyProviderUI();
});
providerCozeBtn.addEventListener('click', () => {
  config.provider = 'coze';
  applyProviderUI();
});
saveConfigBtn.addEventListener('click', () => void saveConfig());

async function init(): Promise<void> {
  await loadConfig();
  setStatus('idle');
}

init();
