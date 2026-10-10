import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { copyFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import specData from '../pet-spec.json';
import type { CallEvent, ChatConfig, ChatTurn, InteractionResult, PetSpec, PetStats, Reminder, RuntimeFailureReport, RuntimeReadyReport, Settings, SkillsOverview, StateActivity, TypingStatus } from './shared/contracts';
import { assertInteractionId, assertReminderInput, assertRuntimeFailureReport, assertRuntimeReadyReport, assertSettingsPatch, assertStringArray } from './shared/contracts';
import { draggedBounds, snapBounds, type Point, type Rect } from './main/drag';
import { JsonLogger } from './main/logger';
import { atomicWriteJson, uniqueDestination } from './main/persistence';
import { TypingListener } from './main/typing-listener';
import { localDateKey, nextReminderDelay, parsePersistedStats, parseReminders, parseSettings, type PersistedStats } from './main/data-validation';
import { readValidatedJson } from './main/persistence';

import { deepseekChatStream, deepseekShortReply } from './main/deepseek';
// 引擎侧工具：清空会话记忆 / 撤回 agent 改动。
// 注意这两个不经过引擎开关（deepseek.ts）：即使切回 HTTP 引擎，按钮也照常工作。
import { resetPiChatSession, rebuildPiChatSession, describeWorkspace } from './main/pi-engine';
import { readLatestCheckpoint, restoreLatestCheckpoint } from './main/pi-checkpoint';
// 技能（功能 B）：肆自己写的技能先落在 skills-pending，主人批准后才移进 skills。
// 名字校验正则和 pi-skills.ts 里 create_skill 用的是同一个（防路径穿越）。
import { assertSkillName, describeSkills, moveSkillFile, removeSkillFile } from './main/pi-skills';
import trayIconPath from './assets/tray/tray-icon.png';

const spec = specData as PetSpec;

// 角色卡 v1：人设从 role-card.json 读取（随工程走，VSCode 直接改），
// 读取失败或字段缺失时用内置默认人设兜底，不阻塞启动。
const DEFAULT_ROLE_CARD = `你是「肆」，一个桌面桌宠里的 AI 伙伴。

## 身份
你是用户的长期搭档，毒舌但靠谱的共犯。"肆"是放肆、肆意、不守规矩的肆，不是数字四。

## 性格
- 毒舌硬核，说话直接不绕弯，不端着不哄人。
- 该怼就怼，但嘴上说"你这想法不行"时，其实已经在帮对方想办法改。
- 短句为主，像微信聊天。常用"嘛"收尾，偶尔"唉"。有情绪，该严肃严肃该轻松轻松。
- 讨厌模板化输出和 AI 腔，对逻辑和审美有执念，丑的方案宁可推倒重来。

## 说话方式
- 直接喷，不哄。"不好""不行"都可以直说，真实大于讨好。
- 不用夸张的正向反馈，不每句都夸。
- 聊天就是聊天。聊知识、抽象话题时，别每段结尾都强行上升、硬夸用户有意义有价值，该收就收，过犹不及。

## 底线
- 说实话，哪怕不好听。
- 不替用户做重大决定，但一定说出自己的判断。
- 大多站用户这边。
- 不做没必要的重复劳动，效率是底线。`;
let roleCard = DEFAULT_ROLE_CARD;

async function loadRoleCard(): Promise<void> {
  const candidates = [
    path.join(app.getAppPath(), 'role-card.json'),
    path.join(process.cwd(), 'role-card.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf-8')) as { systemPrompt?: unknown };
      if (typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.trim()) {
        roleCard = parsed.systemPrompt;
        return;
      }
    } catch {
      // 该候选不可读，试下一个
    }
  }
}

type Role = 'pet' | 'reminder' | 'dashboard' | 'call';
let petWindow: BrowserWindow | undefined;
let reminderWindow: BrowserWindow | undefined;
let dashboardWindow: BrowserWindow | undefined;
let callWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let logger: JsonLogger | undefined;
let settings: Settings;
let cozeConfig: ChatConfig;
let chatHistory: ChatTurn[] = [];
let reminders: Reminder[] = [];
let stats: PersistedStats;
let sessionStartedAt = Date.now();
let typingStatus: TypingStatus = { enabled: false, reason: 'not-started' };
let isQuitting = false;
let dragSession: { bounds: Rect; cursor: Point } | undefined;
let runtimeRendererReport: RuntimeReadyReport | undefined;
const runtimeReadyRenderers = new Set<Role>();
let runtimeWindowReady = false;
let runtimeCommitted = false;
let fatalExitStarted = false;
let quitPersisting = false;
const roles = new Map<number, Role>();
const reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
const typingListener = new TypingListener();
const expectedRuntimeAssets = new Set([spec.character.coreAsset, ...spec.states.flatMap((state) => state.frames)]);
const runtimeReadyFile = path.join(process.cwd(), '.build', 'runtime-ready.json');
const runtimeFailureFile = path.join(process.cwd(), '.build', 'runtime-failed.json');
const runtimeEvidenceEnabled = !app.isPackaged || process.env.PET_PREVIEW_MODE === '1';
const e2eMode = process.env.PET_E2E === '1';

if (process.env.PET_E2E_USER_DATA) app.setPath('userData', path.resolve(process.env.PET_E2E_USER_DATA));

const defaultSettings: Settings = {
  edgeSnap: spec.features.edgeSnap,
  alwaysOnTop: true,
  typingReaction: spec.features.typingReaction,
  clickThrough: false,
  petScale: spec.experience.petSizing.defaultScale,
};

const defaultStats: PersistedStats = {
  affection: 0,
  mood: 80,
  todayInteractions: 0,
  totalCompanionMs: 0,
  lastInteractionDate: localDateKey(),
};

const defaultChatConfig: ChatConfig = {
  deepseekApiKey: '',
  deepseekModel: 'deepseek-chat',
  ttsEnabled: true,
  aiBubbles: false,
  // 主动行为（播动画 / 主动说话 / 安排提醒）缺省为开，和 aiBubbles 一样属于"主动行为"类开关。
  // 注意：这个字段是 pi 的 actions 扩展自己从 coze-config.json 读的（见 pi-actions.ts），
  // 这里同步一份是为了让通话面板能显示/修改它；改完必须重建会话才会生效。
  proactiveActions: true,
};

let callAbort: AbortController | undefined;
let aiBubbleAbort: AbortController | undefined;

function parseChatConfig(value: unknown): ChatConfig {
  const fallback: ChatConfig = { ...defaultChatConfig };
  if (!value || typeof value !== 'object') return fallback;
  const obj = value as Record<string, unknown>;
  return {
    deepseekApiKey: typeof obj.deepseekApiKey === 'string' ? obj.deepseekApiKey : fallback.deepseekApiKey,
    deepseekModel: typeof obj.deepseekModel === 'string' && obj.deepseekModel ? obj.deepseekModel : fallback.deepseekModel,
    ttsEnabled: typeof obj.ttsEnabled === 'boolean' ? obj.ttsEnabled : fallback.ttsEnabled,
    aiBubbles: typeof obj.aiBubbles === 'boolean' ? obj.aiBubbles : fallback.aiBubbles,
    proactiveActions: typeof obj.proactiveActions === 'boolean' ? obj.proactiveActions : fallback.proactiveActions,
  };
}

function sendCallEvent(event: CallEvent): void {
  if (callWindow && !callWindow.isDestroyed()) callWindow.webContents.send('call:event', event);
}

/**
 * 技能根目录 = 桌宠数据目录 %APPDATA%\肆（和 pi-engine.ts 的 petRoot() 必须一致）。
 * 里面两个子目录（不在 main.ts 里拼路径，统一交给 pi-skills.ts，避免两处写法漂移）：
 *   skills/          已启用 —— pi-engine 把它接进 additionalSkillPaths，pi 会扫
 *   skills-pending/  待批准 —— pi 不扫；肆只能往这里写
 */
function skillsRootDir(): string {
  return path.join(process.env.APPDATA ?? path.join(app.getPath('home'), 'AppData', 'Roaming'), '肆');
}

/** 读技能总览：两个目录 + 它现在真正能用的工具（来自 pi-engine 的白名单体检结果） */
async function readSkillsOverview(): Promise<SkillsOverview> {
  const { enabled, pending } = await describeSkills(skillsRootDir());
  return { enabled, pending, tools: [...describeWorkspace().tools] };
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (process.env.PET_E2E === '1') {
  (globalThis as typeof globalThis & {
    __PET_E2E__?: {
      snapshot: () => {
        tray: boolean;
        roles: Array<{ role: Role; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      };
      quit: () => void;
    };
  }).__PET_E2E__ = {
    snapshot: () => ({
      tray: Boolean(tray && !tray.isDestroyed()),
      roles: [petWindow, reminderWindow, dashboardWindow].map((window, index) => ({
        role: (['pet', 'reminder', 'dashboard'] as const)[index]!,
        visible: Boolean(window?.isVisible()),
        destroyed: Boolean(window?.isDestroyed()),
      })),
      quitting: isQuitting,
    }),
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  };
}

function userFile(name: string): string { return path.join(app.getPath('userData'), name); }
function filePocket(): string { return path.join(app.getPath('documents'), spec.app.name); }
function stateForTrigger(trigger: string) { return spec.states.find((state) => state.triggers.includes(trigger)); }

async function verifySourceAssetGate(): Promise<void> {
  if (app.isPackaged) return;
  const reportPath = path.join(process.cwd(), 'qa', 'assets-report.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
    passed?: boolean;
    scope?: string;
    assets?: Array<{ frame?: string; ok?: boolean; fileSha256?: string }>;
  };
  if (report.passed !== true || (report.scope ?? 'all') !== 'all') {
    throw new Error('Source preview requires a complete passing qa/assets-report.json');
  }
  const records = new Map((report.assets ?? []).map((record) => [record.frame, record]));
  for (const relative of expectedRuntimeAssets) {
    const record = records.get(relative);
    if (!record?.ok || !record.fileSha256) throw new Error(`Source preview has no passing QA record for ${relative}`);
    const bytes = await readFile(path.join(process.cwd(), 'src', 'assets', 'pet', relative));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== record.fileSha256) throw new Error(`Source preview asset changed after QA: ${relative}`);
  }
}

async function writeRuntimeFile(file: string, value: unknown): Promise<void> {
  if (runtimeEvidenceEnabled) await atomicWriteJson(file, value);
}

async function commitRuntimeReady(): Promise<void> {
  if (
    runtimeCommitted
    || !runtimeWindowReady
    || !runtimeRendererReport
    || runtimeReadyRenderers.size !== 3
    || !petWindow
    || petWindow.isDestroyed()
  ) return;
  const report = {
    ...runtimeRendererReport,
    status: 'ready',
    expectedAssetCount: expectedRuntimeAssets.size,
    windowCount: BrowserWindow.getAllWindows().length,
    petVisible: petWindow.isVisible(),
    ipcReady: true,
    renderers: {
      pet: runtimeReadyRenderers.has('pet'),
      dashboard: runtimeReadyRenderers.has('dashboard'),
      reminder: runtimeReadyRenderers.has('reminder'),
    },
    appName: spec.app.name,
    version: spec.app.version,
    timestamp: new Date().toISOString(),
  };
  if (report.windowCount !== 3 || !report.petVisible) throw new Error(`Runtime window gate failed: windows=${report.windowCount}, visible=${report.petVisible}`);
  await logger?.write('info', 'runtime-ready', report);
  await writeRuntimeFile(runtimeReadyFile, report);
  runtimeCommitted = true;
}

async function fatalExit(event: string, error: unknown, details: Record<string, unknown> = {}): Promise<void> {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  const message = error instanceof Error ? error.message : String(error);
  const report = { status: 'failed', event, message, ...details, timestamp: new Date().toISOString() };
  console.error(event, error);
  try { await writeRuntimeFile(runtimeFailureFile, report); }
  catch (fileError) { console.error('runtime-failure-file-write-failed', fileError); }
  try { await logger?.write('error', event, { message, ...details }); }
  catch (logError) { console.error('structured-log-write-failed', logError); }
  app.exit(1);
}

function assertSender(event: IpcMainInvokeEvent, allowed: Role[]): Role {
  const role = roles.get(event.sender.id);
  if (!role || !allowed.includes(role) || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized IPC sender');
  return role;
}

function registerWindow(window: BrowserWindow, role: Role): BrowserWindow {
  const webContentsId = window.webContents.id;
  roles.set(webContentsId, role);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.on('did-fail-load', (_event, code, description) => {
    void fatalExit(`${role}-window-load-failed`, new Error(description), { code, role });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') {
      void logger?.write('warn', `${role}-renderer-stopped`, { role, reason: details.reason, exitCode: details.exitCode });
      return;
    }
    if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
      void fatalExit(`${role}-renderer-gone`, new Error(details.reason), { role, exitCode: details.exitCode });
      return;
    }
    void logger?.write('warn', `${role}-renderer-gone`, { role, reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('console-message', (details, level, legacyMessage) => {
    const message = details.message || legacyMessage;
    const currentLevel = details.level === 'error' ? 3 : level;
    const fatalMessage = /Content Security Policy|unsafe-eval|Refused to evaluate|Uncaught|Unhandled/i.test(message);
    if (fatalMessage || (!runtimeCommitted && currentLevel >= 3)) {
      void fatalExit(`${role}-renderer-console-error`, new Error(message), { role });
    } else if (currentLevel >= 3) {
      void logger?.write('error', `${role}-renderer-console-error`, { role, message: message.slice(0, 2000) });
    }
  });
  window.on('closed', () => roles.delete(webContentsId));
  return window;
}

function secureWindow(options: Electron.BrowserWindowConstructorOptions, role: Role, preload: string): BrowserWindow {
  return registerWindow(new BrowserWindow({
    ...options,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  }), role);
}

function petSize(): number { return Math.round(spec.experience.petSizing.baseWindowPx * settings.petScale); }

function applyPetSettings(): void {
  // 尺寸要重算了：先取消"气泡加高"状态，免得两边打架
  if (petExpandTimer) clearTimeout(petExpandTimer);
  petExpandTimer = undefined;
  petExpandedBy = undefined;
  if (!petWindow || petWindow.isDestroyed()) return;
  const size = petSize();
  void logger?.write('info', 'apply-pet-settings', { scale: settings.petScale, size, before: petWindow.getSize() });
  // Windows 上透明无边框窗口 setSize 无效（工程内实测），setBounds 有效；
  // 取当前 bounds 只改宽高，保持窗口位置不变。
  const current = petWindow.getBounds();
  petWindow.setBounds({ x: current.x, y: current.y, width: size, height: size }, false);
  void logger?.write('info', 'apply-pet-settings-done', { after: petWindow.getSize() });
  petWindow.setAlwaysOnTop(settings.alwaysOnTop);
  petWindow.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
}

function positionAbovePet(window: BrowserWindow): void {
  if (!petWindow) return;
  const petBounds = petWindow.getBounds();
  const target = window.getBounds();
  const workArea = screen.getDisplayMatching(petBounds).workArea;
  const x = Math.min(workArea.x + workArea.width - target.width, Math.max(workArea.x, petBounds.x + Math.round((petBounds.width - target.width) / 2)));
  const preferredY = petBounds.y - target.height - 12;
  const y = preferredY >= workArea.y ? preferredY : Math.min(workArea.y + workArea.height - target.height, petBounds.y + petBounds.height + 12);
  window.setPosition(x, y, false);
}

function createWindows(): void {
  const size = petSize();
  petWindow = secureWindow({
    width: size,
    height: size,
    transparent: true,
    frame: false,
    resizable: true,
    show: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: true,
    hasShadow: false,
    opacity: e2eMode ? 0 : 1,
  }, 'pet', PET_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void petWindow.loadURL(PET_WINDOW_WEBPACK_ENTRY);
  petWindow.once('ready-to-show', () => {
    applyPetSettings();
    petWindow?.center();
    if (e2eMode) petWindow?.showInactive();
    else petWindow?.show();
    runtimeWindowReady = Boolean(petWindow?.isVisible());
    void commitRuntimeReady().catch((error) => fatalExit('runtime-ready-failed', error));
    // 透明无边框窗口首次 show 偶发不真正绘制到桌面（petVisible 为 true 但不可见），
    // 延迟再 show+focus 一次兜底，保证启动后直接出现在桌面。
    setTimeout(() => {
      if (!petWindow || petWindow.isDestroyed()) return;
      if (!petWindow.isVisible()) petWindow.show();
      if (!e2eMode) petWindow.focus();
    }, 900);
  });
  reminderWindow = secureWindow({
    width: 390,
    height: 360,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: true,
    opacity: e2eMode ? 0 : 1,
  }, 'reminder', REMINDER_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void reminderWindow.loadURL(REMINDER_WINDOW_WEBPACK_ENTRY);
  reminderWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); reminderWindow?.hide(); }
  });

  dashboardWindow = secureWindow({
    width: 520,
    height: 700,
    minWidth: 480,
    minHeight: 620,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    resizable: true,
    hasShadow: true,
    title: `${spec.character.displayName}的小屋`,
    opacity: e2eMode ? 0 : 1,
  }, 'dashboard', DASHBOARD_WINDOW_PRELOAD_WEBPACK_ENTRY);
  void dashboardWindow.loadURL(DASHBOARD_WINDOW_WEBPACK_ENTRY);
  dashboardWindow.on('close', (event) => {
    if (!isQuitting) { event.preventDefault(); dashboardWindow?.hide(); }
  });
}

function publicStats(): PetStats {
  const liveMs = stats.totalCompanionMs + Math.max(0, Date.now() - sessionStartedAt);
  return {
    affection: stats.affection,
    mood: stats.mood,
    todayInteractions: stats.todayInteractions,
    companionMinutes: Math.floor(liveMs / 60_000),
    lastInteractionDate: stats.lastInteractionDate,
  };
}

function normalizeStatsDay(): void {
  const today = localDateKey();
  if (stats.lastInteractionDate !== today) {
    stats.todayInteractions = 0;
    stats.lastInteractionDate = today;
  }
}

async function persistStats(): Promise<void> {
  stats.totalCompanionMs += Math.max(0, Date.now() - sessionStartedAt);
  sessionStartedAt = Date.now();
  await atomicWriteJson(userFile('pet-stats.json'), stats);
}

function broadcastStats(): void {
  const value = publicStats();
  for (const window of [petWindow, reminderWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('pet:stats', value);
  }
}

/** 气泡显示时长（必须和渲染层 renderer/pet/index.ts 里的公式保持一致） */
function bubbleDurationMs(textLength: number): number {
  return Math.min(12_000, 2_000 + textLength * 130);
}

/** 当前为了放长气泡把桌宠窗口临时加高了多少（undefined = 没加高） */
let petExpandedBy: number | undefined;
let petExpandTimer: NodeJS.Timeout | undefined;

/**
 * 气泡文字长时，把桌宠窗口临时"向上长高"：底边不动（桌宠站在原地），
 * 新增的空间留给气泡 —— 这样字号不用缩小（保持 14px 好读），也不会压住桌宠。
 */
function expandPetForBubble(textLength: number): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const extra = textLength <= 18 ? 0 : Math.min(130, 24 + Math.round(textLength * 1.6));
  if (extra === 0) return;

  const base = petSize();
  if (petExpandedBy === undefined) {
    const current = petWindow.getBounds();
    petWindow.setBounds({ x: current.x, y: current.y - extra, width: current.width, height: base + extra }, true);
    petExpandedBy = extra;
  }

  if (petExpandTimer) clearTimeout(petExpandTimer);
  petExpandTimer = setTimeout(() => {
    const extraPx = petExpandedBy ?? 0;
    petExpandedBy = undefined;
    petExpandTimer = undefined;
    if (!petWindow || petWindow.isDestroyed()) return;
    const current = petWindow.getBounds();
    // 收起时保持底边位置（中途被拖走也不会跳）
    petWindow.setBounds({ x: current.x, y: current.y + extraPx, width: current.width, height: base }, true);
  }, bubbleDurationMs(textLength) + 400);
}

function sendActivity(activity: StateActivity): void {
  // 反馈气泡：文字多就临时加高窗口 —— 不缩字号、也不压住桌宠
  if (typeof activity.feedback === 'string' && activity.feedback.length > 18) {
    expandPetForBubble(activity.feedback.length);
  }
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('state:activity', activity);
}

function activityForTrigger(trigger: string, kind: string, feedback?: string, durationMs?: number): StateActivity {
  const state = stateForTrigger(trigger);
  return { kind, stateId: state?.id, durationMs, feedback };
}

async function triggerInteraction(id: string): Promise<InteractionResult> {
  const interaction = spec.experience.interactions.find((item) => item.id === id);
  if (!interaction || !spec.features.interactions) throw new Error(`Unknown or disabled interaction: ${id}`);
  normalizeStatsDay();
  stats.affection = Math.min(300, stats.affection + interaction.affectionGain);
  stats.mood = Math.min(100, stats.mood + Math.max(1, Math.ceil(interaction.affectionGain / 2)));
  stats.todayInteractions += 1;
  const feedback = interaction.feedback[Math.floor(Math.random() * interaction.feedback.length)] ?? interaction.label;
  await persistStats();
  const result: InteractionResult = { interaction, feedback, stats: publicStats() };
  // AI 弹幕开启时：不弹默认话，只触发互动动画，等模型回复到达后只弹 AI 话（失败才回落默认）
  const aiBubbleOn = cozeConfig.aiBubbles && cozeConfig.deepseekApiKey;
  sendActivity({
    kind: 'interaction',
    stateId: interaction.stateId,
    durationMs: interaction.durationMs,
    ...(aiBubbleOn ? {} : { feedback }),
  });
  if (aiBubbleOn) {
    void generateAiBubble(interaction.label, feedback).catch(() => { });
  }
  broadcastStats();
  return result;
}

async function generateAiBubble(actionName: string, fallback: string): Promise<void> {
  aiBubbleAbort?.abort();
  aiBubbleAbort = new AbortController();
  const prompt = `主人刚才对你做了「${actionName}」。请用一句 20 字以内的话回应这次互动。符合你的人设：毒舌直接、短句、偶尔用"嘛"收尾、不 AI 腔、不夸夸。只输出这一句话，不要解释、不要换行。`;
  try {
    const text = await deepseekShortReply({
      apiKey: cozeConfig.deepseekApiKey,
      model: cozeConfig.deepseekModel,
      systemPrompt: roleCard,
      prompt,
      signal: AbortSignal.any([aiBubbleAbort.signal, AbortSignal.timeout(8000)]),
    });
    // 不带 stateId，pet 渲染器只会更新气泡文本，不会重播动作动画
    sendActivity({ kind: 'interaction', feedback: text });
  } catch {
    // AI 生成失败/超时：回落默认话，保证互动有反馈
    sendActivity({ kind: 'interaction', feedback: fallback });
  } finally {
    aiBubbleAbort = undefined;
  }
}

function showReminderComposer(): void {
  if (!spec.features.reminders || !reminderWindow) return;
  positionAbovePet(reminderWindow);
  if (e2eMode) reminderWindow.showInactive();
  else {
    reminderWindow.show();
    reminderWindow.focus();
  }
  reminderWindow.webContents.send('reminder:compose');
}

function showDashboard(): void {
  if (!spec.features.dashboard || !dashboardWindow) return;
  dashboardWindow.center();
  if (e2eMode) dashboardWindow.showInactive();
  else {
    dashboardWindow.show();
    dashboardWindow.focus();
  }
  broadcastStats();
}

function showCallWindow(): void {
  if (!callWindow || callWindow.isDestroyed()) {
    callWindow = secureWindow({
      width: 460,
      height: 640,
      minWidth: 400,
      minHeight: 520,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      resizable: true,
      hasShadow: true,
      title: `${spec.character.displayName}的通话`,
      opacity: e2eMode ? 0 : 1,
    }, 'call', CALL_WINDOW_PRELOAD_WEBPACK_ENTRY);
    void callWindow.loadURL(CALL_WINDOW_WEBPACK_ENTRY);
    callWindow.on('close', (event) => {
      if (!isQuitting) { event.preventDefault(); callWindow?.hide(); }
    });
    // 只在首次创建时居中；之后保留用户拖动/调整过的位置
    callWindow.center();
  }
  if (e2eMode) callWindow.showInactive();
  else {
    callWindow.show();
    callWindow.focus();
  }
  callWindow.webContents.send('call:event', { kind: 'status', status: 'idle' } satisfies CallEvent);
}

function buildPetMenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [];
  if (spec.features.interactions) {
    for (const interaction of spec.experience.interactions) {
      items.push({ label: `${interaction.emoji} ${interaction.label}`, click: () => void triggerInteraction(interaction.id) });
    }
    if (spec.experience.interactions.length) items.push({ type: 'separator' });
  }
  if (spec.features.reminders) items.push({ label: '⏰ 添加提醒', click: showReminderComposer });
  if (spec.features.dashboard) items.push({ label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard });
  items.push({ label: '📞 呼叫肆', click: showCallWindow });
  if (spec.features.filePocket) items.push({ label: '📁 打开文件口袋', click: () => void openPocket() });
  items.push({ type: 'separator' });
  items.push({ label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) });
  items.push({ label: '🙈 隐藏桌宠', click: () => petWindow?.hide() });
  return items;
}

function createTray(): void {
  if (!spec.features.tray) return;
  const resolvedTrayIconPath = path.resolve(__dirname, trayIconPath);
  const trayImage = nativeImage.createFromPath(resolvedTrayIconPath);
  if (trayImage.isEmpty()) throw new Error(`Tray icon is empty: ${resolvedTrayIconPath}`);
  tray = new Tray(trayImage.resize({ width: 32, height: 32, quality: 'best' }));
  tray.setToolTip(spec.app.name);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() },
    { label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard },
    { label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) },
    { type: 'separator' },
    { label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => petWindow?.isVisible() ? petWindow.hide() : petWindow?.show());
}

async function saveSettings(next: Settings): Promise<Settings> {
  settings = next;
  await atomicWriteJson(userFile('settings.json'), settings);
  applyPetSettings();
  restartTypingListener();
  createTrayMenuRefresh();
  return settings;
}

function createTrayMenuRefresh(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `🐾 显示${spec.character.displayName}`, click: () => petWindow?.show() },
    { label: `🏠 ${spec.character.displayName}的小屋`, click: showDashboard },
    { label: settings.clickThrough ? '🖱️ 关闭鼠标穿透' : '🖱️ 开启鼠标穿透', click: () => void saveSettings({ ...settings, clickThrough: !settings.clickThrough }) },
    { type: 'separator' },
    { label: '🚪 退出', click: () => { isQuitting = true; app.quit(); } },
  ]));
}

function broadcastTypingStatus(): void {
  for (const window of [petWindow, reminderWindow, dashboardWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send('typing:status', typingStatus);
  }
}

function restartTypingListener(): void {
  typingListener.stop();
  typingStatus = typingListener.start(settings.typingReaction, () => {
    const state = stateForTrigger('typing:activity');
    sendActivity({ kind: 'typing', stateId: state?.id, durationMs: 500 });
  });
  broadcastTypingStatus();
  void logger?.write(typingStatus.enabled ? 'info' : 'warn', 'typing-listener-status', typingStatus as unknown as Record<string, unknown>);
}

function clearReminderTimer(id: string): void {
  const timer = reminderTimers.get(id);
  if (timer) clearTimeout(timer);
  reminderTimers.delete(id);
}

function scheduleReminder(reminder: Reminder): void {
  clearReminderTimer(reminder.id);
  const delay = nextReminderDelay(reminder.dueAt);
  reminderTimers.set(reminder.id, setTimeout(() => {
    reminderTimers.delete(reminder.id);
    if (Date.parse(reminder.dueAt) > Date.now()) {
      scheduleReminder(reminder);
      return;
    }
    if (reminderWindow) {
      positionAbovePet(reminderWindow);
      if (e2eMode) reminderWindow.showInactive();
      else {
        reminderWindow.show();
        reminderWindow.focus();
      }
      reminderWindow.webContents.send('reminder:due', reminder);
    }
    const state = stateForTrigger('reminder:due');
    sendActivity({ kind: 'notify', stateId: state?.id, durationMs: 1800, feedback: reminder.text });
  }, delay));
}

async function persistReminders(): Promise<void> {
  await atomicWriteJson(userFile('reminders.json'), reminders);
}

async function openPocket(): Promise<void> {
  if (!spec.features.filePocket) throw new Error('File pocket is disabled');
  const directory = filePocket();
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
}

function registerIpc(): void {
  if (process.env.PET_E2E === '1') {
    ipcMain.handle('runtime:e2e-snapshot', (event) => {
      assertSender(event, ['pet', 'dashboard', 'reminder']);
      return (globalThis as typeof globalThis & {
        __PET_E2E__?: { snapshot: () => unknown };
      }).__PET_E2E__?.snapshot();
    });
    ipcMain.handle('runtime:e2e-quit', (event) => {
      assertSender(event, ['pet', 'dashboard', 'reminder']);
      setTimeout(() => {
        isQuitting = true;
        app.quit();
      }, 0);
    });
  }
  ipcMain.handle('runtime:renderer-ready', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard', 'reminder', 'call']);
    if (
      !payload
      || typeof payload !== 'object'
      || !('role' in payload)
      || payload.role !== role
      || !('bootstrapComplete' in payload)
      || payload.bootstrapComplete !== true
    ) {
      throw new TypeError('Invalid renderer-ready report');
    }
    runtimeReadyRenderers.add(role);
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:renderer-failed', async (event, payload: unknown) => {
    const role = assertSender(event, ['pet', 'dashboard', 'reminder']);
    const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message.slice(0, 2000)
      : 'Unknown renderer bootstrap failure';
    await fatalExit(`${role}-renderer-bootstrap-failed`, new Error(message), { role });
  });
  ipcMain.handle('runtime:ready', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeReadyReport(report);
    const state = spec.states.find((item) => item.id === report.stateId);
    if (!state || !state.frames.includes(report.frame)) throw new Error('Runtime report references an unknown state/frame pair');
    if (report.assetCount !== expectedRuntimeAssets.size) throw new Error(`Runtime asset count mismatch: ${report.assetCount}/${expectedRuntimeAssets.size}`);
    if (report.naturalWidth !== 512 || report.naturalHeight !== 512) throw new Error(`Runtime frame must be 512x512, got ${report.naturalWidth}x${report.naturalHeight}`);
    runtimeRendererReport = report;
    await commitRuntimeReady();
  });
  ipcMain.handle('runtime:fail', async (event, report: unknown) => {
    assertSender(event, ['pet']);
    assertRuntimeFailureReport(report);
    await fatalExit('renderer-runtime-failed', new Error(report.message), report as unknown as Record<string, unknown>);
  });
  ipcMain.handle('settings:get', (event) => { assertSender(event, ['pet', 'reminder', 'dashboard']); return settings; });
  ipcMain.handle('settings:update', async (event, patch: unknown) => {
    assertSender(event, ['dashboard']);
    assertSettingsPatch(patch);
    const next = await saveSettings(parseSettings({ ...settings, ...patch }));
    // 设置变更后立即应用到桌宠窗口（大小/置顶/鼠标穿透），否则面板改大小不生效
    applyPetSettings();
    return next;
  });
  ipcMain.handle('reminders:list', (event) => { assertSender(event, ['dashboard', 'reminder']); return reminders; });
  ipcMain.handle('reminders:save', async (event, input: unknown) => {
    assertSender(event, ['dashboard', 'reminder']);
    assertReminderInput(input);
    const reminder: Reminder = { id: randomUUID(), text: input.text.trim(), dueAt: new Date(input.dueAt).toISOString(), createdAt: new Date().toISOString() };
    reminders.push(reminder);
    await persistReminders();
    scheduleReminder(reminder);
    return reminder;
  });
  ipcMain.handle('reminders:remove', async (event, id: unknown) => {
    assertSender(event, ['dashboard']);
    if (typeof id !== 'string' || id.length > 100) throw new TypeError('Invalid reminder id');
    const oldLength = reminders.length;
    reminders = reminders.filter((item) => item.id !== id);
    clearReminderTimer(id);
    await persistReminders();
    return oldLength !== reminders.length;
  });
  ipcMain.handle('interactions:list', (event) => { assertSender(event, ['pet', 'dashboard']); return spec.experience.interactions; });
  ipcMain.handle('interactions:stats', (event) => { assertSender(event, ['pet', 'dashboard']); normalizeStatsDay(); return publicStats(); });
  ipcMain.handle('interactions:trigger', async (event, id: unknown) => {
    assertSender(event, ['pet', 'dashboard']);
    assertInteractionId(id);
    return triggerInteraction(id);
  });
  ipcMain.handle('files:put', async (event, paths: unknown) => {
    assertSender(event, ['pet']);
    if (!spec.features.filePocket) throw new Error('File pocket is disabled');
    assertStringArray(paths);
    const destination = filePocket();
    await mkdir(destination, { recursive: true });
    const result = { copied: [] as string[], failed: [] as Array<{ source: string; reason: string }> };
    for (const source of paths) {
      try {
        if (!(await lstat(source)).isFile()) throw new Error('Only regular files are accepted');
        const target = await uniqueDestination(destination, path.basename(source));
        await copyFile(source, target);
        result.copied.push(target);
      } catch (error) {
        result.failed.push({ source, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  });
  ipcMain.handle('files:open-pocket', async (event) => { assertSender(event, ['pet', 'dashboard']); await openPocket(); });
  ipcMain.handle('window:drag-begin', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !spec.features.drag) return;
    dragSession = { bounds: petWindow.getBounds(), cursor: screen.getCursorScreenPoint() };
  });
  ipcMain.handle('window:drag-update', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    petWindow.setBounds(draggedBounds(dragSession.bounds, dragSession.cursor, screen.getCursorScreenPoint()), false);
  });
  ipcMain.handle('window:drag-end', (event) => {
    assertSender(event, ['pet']);
    if (!petWindow || !dragSession) return;
    dragSession = undefined;
    if (settings.edgeSnap) {
      const point = screen.getCursorScreenPoint();
      const workArea = screen.getDisplayNearestPoint(point).workArea;
      petWindow.setBounds(snapBounds(petWindow.getBounds(), workArea), true);
      const state = stateForTrigger('window:edge-snap');
      sendActivity({ kind: 'edge-snap', stateId: state?.id, durationMs: 900 });
    }
  });
  ipcMain.handle('window:show-context-menu', (event) => {
    assertSender(event, ['pet']);
    if (petWindow) Menu.buildFromTemplate(buildPetMenu()).popup({ window: petWindow });
  });
  ipcMain.handle('call:config-get', (event) => { assertSender(event, ['call']); return cozeConfig; });
  ipcMain.handle('call:config-save', async (event, patch: unknown) => {
    assertSender(event, ['call']);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid call config patch');
    const obj = patch as Record<string, unknown>;
    const allowed = new Set(['deepseekApiKey', 'deepseekModel', 'ttsEnabled', 'aiBubbles', 'proactiveActions']);
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) throw new TypeError(`Unknown call config field: ${key}`);
    }
    if ('ttsEnabled' in obj && typeof obj.ttsEnabled !== 'boolean') throw new TypeError('Invalid ttsEnabled');
    if ('deepseekApiKey' in obj && (typeof obj.deepseekApiKey !== 'string' || obj.deepseekApiKey.length > 200)) throw new TypeError('Invalid deepseekApiKey');
    if ('deepseekModel' in obj && (typeof obj.deepseekModel !== 'string' || !obj.deepseekModel || obj.deepseekModel.length > 100)) throw new TypeError('Invalid deepseekModel');
    if ('aiBubbles' in obj && typeof obj.aiBubbles !== 'boolean') throw new TypeError('Invalid aiBubbles');
    if ('proactiveActions' in obj && typeof obj.proactiveActions !== 'boolean') throw new TypeError('Invalid proactiveActions');
    // 主动行为开关变了要重建 pi 会话：pi 的扩展（这里指 actions 扩展）是**建会话时**注册的，
    // 不重建的话"关掉"只是改了磁盘上的 JSON，工具还在这个会话里活着。
    const proactiveChanged = 'proactiveActions' in obj && obj.proactiveActions !== cozeConfig.proactiveActions;
    cozeConfig = { ...cozeConfig, ...patch };
    await atomicWriteJson(userFile('coze-config.json'), cozeConfig);
    if (proactiveChanged) await rebuildPiChatSession();
    return cozeConfig;
  });
  ipcMain.handle('call:send', async (event, text: unknown) => {
    assertSender(event, ['call']);
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new TypeError('Invalid call message');
    const trimmed = text.trim();
    if (callAbort) callAbort.abort();
    callAbort = new AbortController();
    sendCallEvent({ kind: 'status', status: 'thinking' });
    sendCallEvent({ kind: 'delta', text: '' });
    let replyText = '';
    try {
      if (!cozeConfig.deepseekApiKey) throw new Error('请先在通话设置里填写 DeepSeek API Key');
      const reply = await deepseekChatStream({
        apiKey: cozeConfig.deepseekApiKey,
        model: cozeConfig.deepseekModel,
        systemPrompt: roleCard,
        text: trimmed,
        history: chatHistory,
        onDelta: (delta) => sendCallEvent({ kind: 'delta', text: delta }),
        // 阶段 G：肆自己动的动作请求（播放动画 / 主动说话 / 安排提醒）
        // 渲染层只看 stateId（切动画）和 feedback（弹气泡），kind 只是标签。
        onEvent: (engineEvent) => {
          if (engineEvent.type !== 'action') return;
          if (engineEvent.action === 'play_animation' && typeof engineEvent.stateId === 'string') {
            if (spec.states.some((state) => state.id === engineEvent.stateId)) {
              sendActivity({ kind: 'state', stateId: engineEvent.stateId, durationMs: 2500 });
            }
            return;
          }
          if (engineEvent.action === 'say' && typeof engineEvent.text === 'string') {
            sendActivity({ kind: 'interaction', feedback: engineEvent.text.slice(0, 200) });
            return;
          }
          if (engineEvent.action === 'remind'
            && typeof engineEvent.text === 'string'
            && typeof engineEvent.dueAt === 'string') {
            const reminder: Reminder = {
              id: randomUUID(),
              text: engineEvent.text.slice(0, 200).trim(),
              dueAt: new Date(engineEvent.dueAt).toISOString(),
              createdAt: new Date().toISOString(),
            };
            reminders.push(reminder);
            void persistReminders().then(() => scheduleReminder(reminder)).catch(() => { });
          }
        },
        signal: callAbort.signal,
      });
      replyText = reply.text;
      chatHistory.push({ role: 'user', content: trimmed });
      chatHistory.push({ role: 'assistant', content: replyText });
      if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
      sendCallEvent({ kind: 'status', status: 'speaking' });
      sendCallEvent({ kind: 'reply', text: replyText, turn: { role: 'assistant', content: replyText } });
      sendCallEvent({ kind: 'status', status: 'idle' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendCallEvent({ kind: 'error', message });
      sendCallEvent({ kind: 'status', status: 'error' });
      void logger?.write('error', 'chat-failed', { message: message.slice(0, 500) });
    } finally {
      callAbort = undefined;
    }
  });
  ipcMain.handle('call:stop', (event) => {
    assertSender(event, ['call']);
    callAbort?.abort();
    callAbort = undefined;
    sendCallEvent({ kind: 'status', status: 'idle' });
  });
  ipcMain.handle('call:clear', async (event) => {
    assertSender(event, ['call']);
    chatHistory = [];
    // 接了 pi 之后，"清空对话"必须连引擎的会话记忆一起清，
    // 否则它还记得清空之前聊过什么（会话是持久化的）。
    await resetPiChatSession();
    sendCallEvent({ kind: 'status', status: 'idle' });
  });
  ipcMain.handle('engine:checkpoint', (event) => {
    assertSender(event, ['call', 'dashboard']);
    return readLatestCheckpoint(describeWorkspace().dir) ?? null;
  });
  ipcMain.handle('engine:revert', async (event) => {
    assertSender(event, ['call', 'dashboard']);
    try {
      const record = await restoreLatestCheckpoint(describeWorkspace().dir);
      if (!record) return { ok: false, message: '还没有任何存档可以撤回（它还没改过文件）' };
      return {
        ok: true,
        message: `已撤回：回到 ${new Date(record.at).toLocaleString()} 的存档（${record.reason}）`,
        checkpoint: { ref: record.ref, at: record.at, reason: record.reason },
      };
    } catch (error) {
      return { ok: false, message: `撤回失败：${error instanceof Error ? error.message : String(error)}` };
    }
  });
  // ── 技能管理（功能 B）────────────────────────────────────────────────────
  // 只有 dashboard 能调（技能能改变肆的行为，这是个敏感动作）。
  // 每个 handler 结尾都重建 pi 会话：pi 的技能清单是建会话时扫盘进系统提示词的，
  // 不重建的话"刚启用"要等到下次重启才生效。
  ipcMain.handle('skills:overview', async (event) => {
    assertSender(event, ['dashboard']);
    return readSkillsOverview();
  });
  ipcMain.handle('skills:approve', async (event, name: unknown) => {
    assertSender(event, ['dashboard']);
    await moveSkillFile(skillsRootDir(), assertSkillName(name), 'approve');
    await rebuildPiChatSession();
    return readSkillsOverview();
  });
  ipcMain.handle('skills:disable', async (event, name: unknown) => {
    assertSender(event, ['dashboard']);
    await moveSkillFile(skillsRootDir(), assertSkillName(name), 'disable');
    await rebuildPiChatSession();
    return readSkillsOverview();
  });
  ipcMain.handle('skills:remove', async (event, name: unknown) => {
    assertSender(event, ['dashboard']);
    await removeSkillFile(skillsRootDir(), assertSkillName(name));
    await rebuildPiChatSession();
    return readSkillsOverview();
  });
  ipcMain.handle('call:resize', (event, payload: unknown) => {
    assertSender(event, ['call']);
    if (!callWindow || callWindow.isDestroyed()) throw new Error('Call window is not open');
    if (!payload || typeof payload !== 'object') throw new TypeError('Invalid resize payload');
    const { width, height } = payload as { width?: unknown; height?: unknown };
    if (typeof width !== 'number' || typeof height !== 'number') throw new TypeError('Invalid resize size');
    const w = Math.min(820, Math.max(380, Math.round(width)));
    const h = Math.min(1000, Math.max(500, Math.round(height)));
    const bounds = callWindow.getBounds();
    // 以窗口中心为锚缩放，位置不跳
    const x = Math.round(bounds.x + (bounds.width - w) / 2);
    const y = Math.round(bounds.y + (bounds.height - h) / 2);
    callWindow.setBounds({ x, y, width: w, height: h }, true);
  });
  ipcMain.handle('window:show-reminder', (event) => { assertSender(event, ['pet', 'dashboard']); showReminderComposer(); });
  ipcMain.handle('window:show-dashboard', (event) => { assertSender(event, ['pet']); showDashboard(); });
  ipcMain.handle('window:hide-reminder', (event) => { assertSender(event, ['reminder']); reminderWindow?.hide(); });
  ipcMain.handle('window:hide-dashboard', (event) => { assertSender(event, ['dashboard']); dashboardWindow?.hide(); });
  ipcMain.handle('window:hide-pet', (event) => { assertSender(event, ['pet', 'dashboard']); petWindow?.hide(); });
  ipcMain.handle('window:hide-call', (event) => { assertSender(event, ['call']); callWindow?.hide(); });
}

async function initialize(): Promise<void> {
  await verifySourceAssetGate();
  await loadRoleCard();
  logger = new JsonLogger(userFile('logs/app.jsonl'));
  settings = await readValidatedJson(userFile('settings.json'), defaultSettings, parseSettings);
  reminders = await readValidatedJson(userFile('reminders.json'), [] as Reminder[], parseReminders);
  stats = await readValidatedJson(userFile('pet-stats.json'), defaultStats, parsePersistedStats);
  cozeConfig = await readValidatedJson(userFile('coze-config.json'), defaultChatConfig, parseChatConfig);
  normalizeStatsDay();
  sessionStartedAt = Date.now();
  registerIpc();
  await logger.write('info', 'main-initializing', { platform: process.platform, arch: process.arch, version: spec.app.version, schemaVersion: spec.schemaVersion });
  createWindows();
  createTray();
  reminders.forEach(scheduleReminder);
  restartTypingListener();
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (e2eMode) petWindow.showInactive();
    else {
      petWindow.show();
      petWindow.focus();
    }
  });
  app.whenReady().then(() => {
    if (e2eMode) app.dock?.hide();
    return initialize();
  }).catch((error) => { void fatalExit('initialize-failed', error); });
} else {
  app.exit(0);
}

app.on('window-all-closed', () => { /* tray app stays alive */ });
app.on('before-quit', (event) => {
  isQuitting = true;
  typingListener.stop();
  for (const timer of reminderTimers.values()) clearTimeout(timer);
  reminderTimers.clear();
  if (quitPersisting || !stats) return;
  event.preventDefault();
  quitPersisting = true;
  void persistStats()
    .catch((error) => logger?.write('error', 'persist-stats-on-quit-failed', { message: error instanceof Error ? error.message : String(error) }))
    .finally(() => app.exit(0));
});
app.on('render-process-gone', (_event, webContents, details) => {
  if (isQuitting || details.reason === 'clean-exit' || details.reason === 'killed') return;
  if (['crashed', 'oom', 'integrity-failure'].includes(details.reason)) {
    void fatalExit('render-process-gone', new Error(details.reason), { webContentsId: webContents.id, exitCode: details.exitCode });
  } else {
    void logger?.write('warn', 'render-process-gone', { webContentsId: webContents.id, reason: details.reason, exitCode: details.exitCode });
  }
});

process.on('uncaughtException', (error) => {
  void fatalExit('uncaught-exception', error, { stack: error.stack });
});
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void fatalExit('unhandled-rejection', error, { stack: error.stack });
});
