// hash-sync 练习：改锁内文件必须同步哈希
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ApprovalDirsOverview, ApprovalRequestView, ApprovalResponseInput, CallEvent, ChatConfig, CompanionSnapshot, EngineCheckpoint, EngineRevertResult, InteractionResult, InteractionSpec, PetAPI, PetStats, Reminder, RuntimeFailureReport, RuntimeReadyReport, Settings, SkillsOverview, StateActivity, TypingStatus } from './shared/contracts';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: PetAPI = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
    update: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<Settings>,
  },
  reminders: {
    list: () => ipcRenderer.invoke('reminders:list') as Promise<Reminder[]>,
    save: (input) => ipcRenderer.invoke('reminders:save', input) as Promise<Reminder>,
    remove: (id) => ipcRenderer.invoke('reminders:remove', id) as Promise<boolean>,
  },
  interactions: {
    list: () => ipcRenderer.invoke('interactions:list') as Promise<InteractionSpec[]>,
    trigger: (id) => ipcRenderer.invoke('interactions:trigger', id) as Promise<InteractionResult>,
    stats: () => ipcRenderer.invoke('interactions:stats') as Promise<PetStats>,
  },
  files: {
    getPathForFile: (file) => webUtils.getPathForFile(file),
    put: (paths) => ipcRenderer.invoke('files:put', paths),
    openPocket: () => ipcRenderer.invoke('files:open-pocket') as Promise<void>,
  },
  window: {
    beginDrag: () => ipcRenderer.invoke('window:drag-begin') as Promise<void>,
    updateDrag: () => ipcRenderer.invoke('window:drag-update') as Promise<void>,
    endDrag: () => ipcRenderer.invoke('window:drag-end') as Promise<void>,
    showContextMenu: () => ipcRenderer.invoke('window:show-context-menu') as Promise<void>,
    showReminder: () => ipcRenderer.invoke('window:show-reminder') as Promise<void>,
    showDashboard: () => ipcRenderer.invoke('window:show-dashboard') as Promise<void>,
    hideReminder: () => ipcRenderer.invoke('window:hide-reminder') as Promise<void>,
    hideDashboard: () => ipcRenderer.invoke('window:hide-dashboard') as Promise<void>,
    hidePet: () => ipcRenderer.invoke('window:hide-pet') as Promise<void>,
    hideCall: () => ipcRenderer.invoke('window:hide-call') as Promise<void>,
  },
  runtime: {
    ready: (report: RuntimeReadyReport) => ipcRenderer.invoke('runtime:ready', report) as Promise<void>,
    fail: (report: RuntimeFailureReport) => ipcRenderer.invoke('runtime:fail', report) as Promise<void>,
  },
  events: {
    onStateActivity: (listener) => subscribe<StateActivity>('state:activity', listener),
    onReminder: (listener) => subscribe<Reminder>('reminder:due', listener),
    onReminderCompose: (listener) => subscribe<void>('reminder:compose', listener),
    onStats: (listener) => subscribe<PetStats>('pet:stats', listener),
    onTypingStatus: (listener) => subscribe<TypingStatus>('typing:status', listener),
  },
  call: {
    getConfig: () => ipcRenderer.invoke('call:config-get') as Promise<ChatConfig>,
    saveConfig: (patch) => ipcRenderer.invoke('call:config-save', patch) as Promise<ChatConfig>,
    send: (text) => ipcRenderer.invoke('call:send', text) as Promise<void>,
    stop: () => ipcRenderer.invoke('call:stop') as Promise<void>,
    clear: () => ipcRenderer.invoke('call:clear') as Promise<void>,
    resize: (width, height) => ipcRenderer.invoke('call:resize', { width, height }) as Promise<void>,
    onEvent: (listener) => subscribe<CallEvent>('call:event', listener),
  },
  engine: {
    checkpoint: () => ipcRenderer.invoke('engine:checkpoint') as Promise<EngineCheckpoint | null>,
    revert: () => ipcRenderer.invoke('engine:revert') as Promise<EngineRevertResult>,
  },
  // 技能管理（功能 B）：肆自己写的技能要主人批准才生效
  skills: {
    overview: () => ipcRenderer.invoke('skills:overview') as Promise<SkillsOverview>,
    approve: (name) => ipcRenderer.invoke('skills:approve', name) as Promise<SkillsOverview>,
    disable: (name) => ipcRenderer.invoke('skills:disable', name) as Promise<SkillsOverview>,
    remove: (name) => ipcRenderer.invoke('skills:remove', name) as Promise<SkillsOverview>,
  },
  // 授权门（阶段 F）：a) 授权小窗回答"这一问"；b) dashboard 看/撤销已授权目录
  approval: {
    list: () => ipcRenderer.invoke('approval:list') as Promise<ApprovalDirsOverview>,
    revoke: (dir) => ipcRenderer.invoke('approval:revoke', dir) as Promise<ApprovalDirsOverview>,
    current: () => ipcRenderer.invoke('approval:current') as Promise<ApprovalRequestView | null>,
    respond: (input: ApprovalResponseInput) => ipcRenderer.invoke('approval:respond', input) as Promise<boolean>,
    onRequest: (listener) => subscribe<ApprovalRequestView>('approval:request', listener),
  },
  // 陪伴感知：只暴露"看最近的活动"和"清空"两个动作。
  // 返回的 CompanionActivity 里只有闭集标签 + 时间戳 —— 窗口标题原文出不了主进程。
  companion: {
    snapshot: () => ipcRenderer.invoke('companion:snapshot') as Promise<CompanionSnapshot>,
    clear: () => ipcRenderer.invoke('companion:clear') as Promise<CompanionSnapshot>,
  },
};

contextBridge.exposeInMainWorld('petAPI', api);
if (process.env.PET_E2E === '1') {
  contextBridge.exposeInMainWorld('__petE2E', {
    snapshot: () => ipcRenderer.invoke('runtime:e2e-snapshot'),
    quit: () => ipcRenderer.invoke('runtime:e2e-quit'),
  });
}

function currentRole(): 'pet' | 'dashboard' | 'reminder' | 'approval' | undefined {
  const pathname = window.location.pathname;
  if (pathname.includes('/pet_window/')) return 'pet';
  if (pathname.includes('/dashboard_window/')) return 'dashboard';
  if (pathname.includes('/reminder_window/')) return 'reminder';
  if (pathname.includes('/approval_window/')) return 'approval';
  return undefined;
}

function reportRendererFailure(message: string): void {
  const role = currentRole();
  if (!role) return;
  void ipcRenderer.invoke('runtime:renderer-failed', { role, message });
}

window.addEventListener('error', (event) => {
  reportRendererFailure(event.error instanceof Error ? event.error.stack || event.error.message : event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportRendererFailure(event.reason instanceof Error ? event.reason.stack || event.reason.message : String(event.reason));
});

window.addEventListener('DOMContentLoaded', () => {
  const role = currentRole();
  if (!role) {
    reportRendererFailure(`Cannot resolve renderer role from ${window.location.pathname}`);
    return;
  }
  window.setTimeout(() => {
    void ipcRenderer.invoke('runtime:renderer-ready', { role, bootstrapComplete: true });
  }, 0);
});
