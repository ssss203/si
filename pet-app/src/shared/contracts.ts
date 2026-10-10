export interface PetSpec {
  schemaVersion: number;
  app: {
    name: string;
    appId: string;
    version: string;
    language: string;
  };
  targets: {
    windows: { enabled: boolean; arch: string };
    macos: { enabled: boolean; arch: string };
  };
  character: {
    inputType: string;
    coreAsset: string;
    displayName: string;
    archetype: string;
    personality: string[];
    preserveTraits: string[];
    style: string;
    mirrorSafe: boolean;
  };
  assetPipeline: {
    backgroundMode: string;
    segmentationBackend: string;
    subjectKind: string;
    generationBackground: string;
    backgroundTolerance: number;
    edgeFeather: number;
    safeMargin: number;
    targetOccupancy: number;
  };
  experience: {
    theme: {
      primary: string;
      accent: string;
      background: string;
      surface: string;
      text: string;
      muted: string;
      cornerRadius: number;
    };
    petSizing: {
      baseWindowPx: number;
      defaultScale: number;
    };
    interactions: InteractionSpec[];
  };
  motion: {
    breathing: { enabled: boolean; periodMs: number; scaleX: number; scaleY: number };
    squashStretch: { enabled: boolean; durationMs: number; intensity: number };
    idleIntervalMs: { min: number; max: number };
  };
  features: {
    transparentWindow: boolean;
    drag: boolean;
    tray: boolean;
    edgeSnap: boolean;
    reminders: boolean;
    interactions: boolean;
    relationship: boolean;
    filePocket: boolean;
    dashboard: boolean;
    typingReaction: boolean;
    autonomousMovement: boolean;
  };
  states: PetState[];
  storage: {
    userData: string;
    filePocket: string;
  };
  build: {
    windows: { arch: string; installer: string; portable: string };
    macos: { arch: string; diskImage: string; portable: string };
    timeoutMinutes: number;
    unsigned: boolean;
  };
}

export interface InteractionSpec {
  id: string;
  emoji: string;
  label: string;
  stateId: string;
  durationMs: number;
  affectionGain: number;
  feedback: string[];
}

export interface PetState {
  id: string;
  triggers: string[];
  frames: string[];
  frameDurationMs: number;
  loop: boolean;
  priority: number;
  interrupt: string;
  cooldownMs: number;
  direction: string;
  anchor: { x: number; y: number };
  mirrorSafe: boolean;
}

export interface PetStats {
  affection: number;
  mood: number;
  todayInteractions: number;
  companionMinutes: number;
  lastInteractionDate: string;
}

export interface Settings {
  edgeSnap: boolean;
  alwaysOnTop: boolean;
  typingReaction: boolean;
  clickThrough: boolean;
  petScale: number;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  createdAt: string;
}

export interface StateActivity {
  kind: string;
  stateId?: string;
  durationMs?: number;
  feedback?: string;
}

export interface RuntimeReadyReport {
  status: string;
  stateId: string;
  frame: string;
  assetCount: number;
  expectedAssetCount: number;
  naturalWidth: number;
  naturalHeight: number;
  petVisible: boolean;
  ipcReady: boolean;
  renderers?: {
    pet: boolean;
    dashboard: boolean;
    reminder: boolean;
  };
}

export interface RuntimeFailureReport {
  message: string;
}

export interface InteractionResult {
  interaction: InteractionSpec;
  feedback: string;
  stats: PetStats;
}

export interface TypingStatus {
  enabled: boolean;
  reason: string;
}

export interface ChatConfig {
  ttsEnabled: boolean;
  deepseekApiKey: string;
  deepseekModel: string;
  aiBubbles: boolean;
  /**
   * 主动行为总开关（播放动画 / 主动说话 / 安排提醒）。
   * 缺省为开；关掉时 pi 的 actions 扩展连工具都不注册。
   * 改这个值必须重建 pi 会话（扩展是建会话时注册的），见 main.ts 的 call:config-save。
   */
  proactiveActions: boolean;
  /**
   * 陪伴感知：让肆偶尔（20~45 分钟随机一次）看一眼当前前台窗口，据此决定要不要搭话。
   *
   * 缺省为 **false（opt-in）** —— 关掉时连采样定时器都不建，一次窗口读取都不会发生。
   * 打开后进对话的**只有闭集标签**（见 CompanionTag），窗口标题原文永不落盘。
   * 改这个值必须重建 pi 会话（注入是建会话时注册的扩展），见 main.ts 的 call:config-save。
   */
  companionAwareness: boolean;
}

/**
 * 陪伴感知的闭集标签 —— **唯一**允许进对话的取值。
 * 与 src/main/pi-companion.ts 的 ACTIVITY_TAGS 必须逐字一致（不一致会编译不过）。
 * 任何自由文本（尤其是窗口标题片段）都不在允许范围内。
 */
export type CompanionTag =
  | 'coding'
  | 'working-with-ai'
  | 'reading-docs'
  | 'searching'
  | 'browsing'
  | 'watching-video'
  | 'listening-music'
  | 'chatting'
  | 'meeting'
  | 'gaming'
  | 'terminal'
  | 'designing'
  | 'idle'
  | 'other';

/**
 * 一条活动记录：**只有标签和时间**。
 * 这个类型里没有 title 字段是有意的 —— 窗口标题原文不离开主进程，永不落盘、永不上 IPC。
 */
export interface CompanionActivity {
  tag: CompanionTag;
  /** 采样时刻（epoch ms） */
  at: number;
  /** 这次活动持续了多久（分钟）；只有它是"最新那条"时才算得出来 */
  durationMinutes?: number;
}

/** dashboard「👀 肆最近看到的活动」要的数据 */
export interface CompanionSnapshot {
  /** 陪伴感知开关当前是不是开着 */
  enabled: boolean;
  /** 最近一次采样的时刻（epoch ms）；从没采样过就是 null */
  lastSampleAt: number | null;
  /** 最近的活动，旧 → 新，最多 10 条 */
  activities: CompanionActivity[];
}

/** 一条技能（肆自己写的 or 主人启用过的） */
export interface SkillInfo {
  name: string;
  description: string;
  /** 文件绝对路径，面板上可以给主人看"它到底往哪写" */
  path: string;
  /** 文件最后修改时间（ISO 字符串） */
  updatedAt: string;
}

/** 技能面板要的全部数据：已启用 / 待批准 / 它现在能用的工具 */
export interface SkillsOverview {
  enabled: SkillInfo[];
  pending: SkillInfo[];
  tools: string[];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type CallEvent =
  | { kind: 'status'; status: 'idle' | 'thinking' | 'speaking' | 'error' }
  | { kind: 'delta'; text: string }
  | { kind: 'reply'; text: string; turn: ChatTurn }
  | { kind: 'error'; message: string };

/** 引擎侧的存档记录（阶段 E）：agent 动手前的 git 快照 */
export interface EngineCheckpoint {
  ref: string;
  at: string;
  reason: string;
}

/** 撤回结果：ok=false 时 message 里写明原因（比如"还没有任何存档"） */
export interface EngineRevertResult {
  ok: boolean;
  message: string;
  checkpoint?: EngineCheckpoint;
}

/** 授权门（阶段 F）主人能做的三个选择 */
export type ApprovalDecision = 'once' | 'dir' | 'deny';

/** 授权门小窗要显示的东西（主进程 → approval 窗口） */
export interface ApprovalRequestView {
  /** 一次询问一个 id；过期的回答会被主进程丢掉 */
  id: string;
  /** 是哪个工具想动手（edit / write） */
  toolName: string;
  /** 目标文件的绝对路径 */
  path: string;
  /** 目标文件所在目录 —— 「这个目录以后都允许」授权的就是它 */
  dir: string;
  /** 到这个时间还没操作就自动拒绝（ISO 字符串，渲染层拿它画倒计时） */
  expiresAt: string;
}

/** dashboard「🔓 已授权目录」要的数据 */
export interface ApprovalDirsOverview {
  /** 已授权的目录绝对路径（含其整棵子树） */
  dirs: string[];
}

/** 授权窗口回给主进程的答复 */
export interface ApprovalResponseInput {
  id: string;
  decision: ApprovalDecision;
}

export interface PetAPI {
  settings: {
    get: () => Promise<Settings>;
    update: (patch: Partial<Settings>) => Promise<Settings>;
  };
  reminders: {
    list: () => Promise<Reminder[]>;
    save: (input: { text: string; dueAt: string }) => Promise<Reminder>;
    remove: (id: string) => Promise<boolean>;
  };
  interactions: {
    list: () => Promise<InteractionSpec[]>;
    trigger: (id: string) => Promise<InteractionResult>;
    stats: () => Promise<PetStats>;
  };
  files: {
    getPathForFile: (file: File) => string;
    put: (paths: string[]) => Promise<{ copied: string[]; failed: Array<{ source: string; reason: string }> }>;
    openPocket: () => Promise<void>;
  };
  window: {
    beginDrag: () => Promise<void>;
    updateDrag: () => Promise<void>;
    endDrag: () => Promise<void>;
    showContextMenu: () => Promise<void>;
    showReminder: () => Promise<void>;
    showDashboard: () => Promise<void>;
    hideReminder: () => Promise<void>;
    hideDashboard: () => Promise<void>;
    hidePet: () => Promise<void>;
    hideCall: () => Promise<void>;
  };
  runtime: {
    ready: (report: RuntimeReadyReport) => Promise<void>;
    fail: (report: RuntimeFailureReport) => Promise<void>;
  };
  events: {
    onStateActivity: (listener: (activity: StateActivity) => void) => () => void;
    onReminder: (listener: (reminder: Reminder) => void) => () => void;
    onReminderCompose: (listener: () => void) => () => void;
    onStats: (listener: (stats: PetStats) => void) => () => void;
    onTypingStatus: (listener: (status: TypingStatus) => void) => () => void;
  };
  call: {
    getConfig: () => Promise<ChatConfig>;
    saveConfig: (patch: Partial<ChatConfig>) => Promise<ChatConfig>;
    send: (text: string) => Promise<void>;
    stop: () => Promise<void>;
    clear: () => Promise<void>;
    resize: (width: number, height: number) => Promise<void>;
    onEvent: (listener: (event: CallEvent) => void) => () => void;
  };
  engine: {
    /** 最近一次存档（agent 动手前的快照）；没有就是 null */
    checkpoint: () => Promise<EngineCheckpoint | null>;
    /** 撤回到最近一次存档：改坏了点一下就回去 */
    revert: () => Promise<EngineRevertResult>;
  };
  /**
   * 技能管理（功能 B）：肆可以自己写技能，但只有主人批准（approve）才会被 pi 加载。
   * 安全模型：默认不加载任何外来东西 —— pi 只扫 <petRoot>/skills，肆只能写 <petRoot>/skills-pending。
   */
  skills: {
    /** 已启用 / 待批准 / 当前工具白名单 */
    overview: () => Promise<SkillsOverview>;
    /** 待批准 → 已启用（文件从 skills-pending 移到 skills） */
    approve: (name: string) => Promise<SkillsOverview>;
    /** 已启用 → 待批准（反向移动，随时能反悔） */
    disable: (name: string) => Promise<SkillsOverview>;
    /** 删除技能文件 */
    remove: (name: string) => Promise<SkillsOverview>;
  };
  /**
   * 授权门（阶段 F）：肆要改工作目录**外**的文件时，弹小窗问主人。
   * 三条通道分得清：approval 窗口只回答「当前这一问」，dashboard 只读列表 + 撤销。
   */
  approval: {
    /** 已授权目录（dashboard 面板用） */
    list: () => Promise<ApprovalDirsOverview>;
    /** 撤销一个目录的授权（它里面的子目录授权也一起撤销） */
    revoke: (dir: string) => Promise<ApprovalDirsOverview>;
    /** 当前这一问（approval 窗口启动时主动拉一次，避免和 loadURL 抢时间） */
    current: () => Promise<ApprovalRequestView | null>;
    /** 主人点了某个按钮；返回 true 表示这一问确实还挂着（过期的答复返回 false） */
    respond: (input: ApprovalResponseInput) => Promise<boolean>;
    /** 新的一问来了（approval 窗口订阅） */
    onRequest: (listener: (request: ApprovalRequestView) => void) => () => void;
  };
  /**
   * 陪伴感知（透明度面板）。
   *
   * 只有 read + clear 两个动作，而且**结构上拿不到原文**：返回的 CompanionActivity
   * 里只有闭集标签和时间。清空只清主进程内存里的最近 10 条，不删任何文件
   * （本来也没为它写过文件）。
   */
  companion: {
    /** 最近看到的活动（标签 + 时间，最多 10 条） */
    snapshot: () => Promise<CompanionSnapshot>;
    /** 清空内存里的活动历史 */
    clear: () => Promise<CompanionSnapshot>;
  };
}

declare global {
  interface Window {
    petAPI?: PetAPI;
    __petE2E?: {
      snapshot: () => Promise<{
        tray: boolean;
        roles: Array<{ role: 'pet' | 'reminder' | 'dashboard'; visible: boolean; destroyed: boolean }>;
        quitting: boolean;
      }>;
      quit: () => Promise<void>;
    };
  }
}

export function assertStringArray(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError('Expected string array');
  for (const item of value) {
    if (typeof item !== 'string') throw new TypeError('Expected string array');
  }
}

export function assertInteractionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 100) {
    throw new TypeError('Invalid interaction id');
  }
}

export function assertSettingsPatch(value: unknown): asserts value is Partial<Settings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid settings patch');
  }
  const obj = value as Record<string, unknown>;
  const booleanKeys = new Set(['edgeSnap', 'alwaysOnTop', 'typingReaction', 'clickThrough']);
  const allowedKeys = new Set([...booleanKeys, 'petScale']);
  for (const [key, item] of Object.entries(obj)) {
    if (!allowedKeys.has(key)) throw new TypeError(`Unknown settings field: ${key}`);
    if (booleanKeys.has(key) && typeof item !== 'boolean') throw new TypeError(`Invalid settings field: ${key}`);
    if (key === 'petScale' && (typeof item !== 'number' || !Number.isFinite(item) || ![0.65, 0.8, 1, 1.2].includes(item))) {
      throw new TypeError('Invalid settings field: petScale');
    }
  }
}

export function assertReminderInput(value: unknown): asserts value is { text: string; dueAt: string } {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid reminder input');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.text !== 'string' || obj.text.length > 500) {
    throw new TypeError('Invalid reminder text');
  }
  if (typeof obj.dueAt !== 'string' || isNaN(Date.parse(obj.dueAt))) {
    throw new TypeError('Invalid reminder dueAt');
  }
}

export function assertRuntimeReadyReport(value: unknown): asserts value is RuntimeReadyReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime ready report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.stateId !== 'string') throw new TypeError('Invalid stateId');
  if (typeof obj.frame !== 'string') throw new TypeError('Invalid frame');
  if (typeof obj.assetCount !== 'number') throw new TypeError('Invalid assetCount');
  if (typeof obj.naturalWidth !== 'number') throw new TypeError('Invalid naturalWidth');
  if (typeof obj.naturalHeight !== 'number') throw new TypeError('Invalid naturalHeight');
}

export function assertRuntimeFailureReport(value: unknown): asserts value is RuntimeFailureReport {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Invalid runtime failure report');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.message !== 'string') throw new TypeError('Invalid message');
}

/** 授权窗口的答复：id 必须是短字符串（主进程用它和当前这一问对号），decision 必须是三个之一 */
export function assertApprovalResponse(value: unknown): asserts value is ApprovalResponseInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid approval response');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0 || obj.id.length > 100) {
    throw new TypeError('Invalid approval id');
  }
  if (obj.decision !== 'once' && obj.decision !== 'dir' && obj.decision !== 'deny') {
    throw new TypeError('Invalid approval decision');
  }
}
