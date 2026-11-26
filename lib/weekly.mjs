// dsh-zentao-panel — 周报纯函数（host 半边）
//
// 口径与参考项目 D:\Desktop\chandao\electron\chandao-service.ts 对齐：
//   - 完成工作：user-task-{userId}-finishedBy（按 finishedDate 过滤，ID 倒序）
//   - Bug 修复：user-bug-{userId}-resolvedBy（按 resolvedDate 过滤，ID 正序）
//   - 下周计划：user-task-{userId}-assignedTo（只留 wait/doing，不按时间过滤）
// 本模块不碰网络/文件，便于单测。

export const WEEKLY_TEXT = Object.freeze({
  department: '研发部',
  itemFallback: '事项',
  statusHandled: '已处理',
  statusResolved: '已解决',
  statusClosed: '已关闭',
  priorityHigh: '高',
  priorityMedium: '中',
  priorityLow: '低',
  rangeJoiner: '至',
  defaultProjectSummary: '当前负责项目',
  overviewTemplate: '本周主要围绕 %s 展开工作，累计完成 %s 项主要任务，处理 %s 个 Bug，并持续推进在研需求与交付支持。',
  summaryDefaultWork: '核心开发事项',
  summaryDefaultPlan: '在研任务',
  summaryTemplate: '本周共完成 %s 项工作，累计工时 %s 小时。重点推进了 %s，并处理 %s 个 Bug。下周将继续围绕 %s 展开。',
});

/** 周报范围上限（天）：防止误选跨年范围把接口打爆。 */
export const WEEKLY_MAX_DAYS = 31;
/** 单区块条目上限（导出校验同口径）。 */
export const WEEKLY_MAX_ITEMS = 200;

/** 禅道页面接口的 data 是 JSON 字符串，需要二次 parse；坏数据返回 null。 */
export function parseEmbeddedJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/** 列表形态不固定：数组或按 id 索引的 dict → 数组。 */
export function normalizeCollection(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM-DD' → 本地 00:00:00 的 Date；非法/不存在日期（如 2 月 30 日）→ null。 */
export function parseDateOnly(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const date = new Date(y, mo, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null;
  return date;
}

/** Date → 本地 'YYYY-MM-DD'。 */
export function formatDateOnly(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 校验周报起止日期（host 与前端同口径）：
 * 必须是 YYYY-MM-DD、start <= end、范围不超过 31 天。
 */
export function validateRange(start, end) {
  const startDate = parseDateOnly(start);
  const endDate = parseDateOnly(end);
  if (!startDate || !endDate) return { ok: false, message: '日期格式非法（应为 YYYY-MM-DD）' };
  if (startDate.getTime() > endDate.getTime()) return { ok: false, message: '开始日期不能晚于结束日期' };
  const days = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  if (days > WEEKLY_MAX_DAYS) return { ok: false, message: `时间范围不能超过 ${WEEKLY_MAX_DAYS} 天` };
  return { ok: true, days };
}

/** 本地时间字符串（'2026-11-25 10:00:00' / '2026-11-25'）→ Date；非法 → null。 */
export function parseLocalDateTime(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 时间值是否落在 [start 00:00:00, end 23:59:59.999]（本地时区，含边界）。 */
export function isDateInRange(value, start, end) {
  const at = parseLocalDateTime(value);
  const from = parseDateOnly(start);
  const to = parseDateOnly(end);
  if (!at || !from || !to) return false;
  const fromMs = from.getTime();
  const toMs = to.getTime() + 86400000 - 1;
  const ms = at.getTime();
  return ms >= fromMs && ms <= toMs;
}

/** 任务标题清洗：去掉开头的「前缀:」/「前缀：」与「YYYY.N」前缀（参考 cleanTaskTitle）。 */
export function cleanTaskTitle(value) {
  return String(value ?? '')
    .replace(/^[^:：]+[:：]\s*/u, '')
    .replace(/^\d{4}\.\d+\s*/u, '')
    .trim();
}

export function mapBugStatus(status) {
  if (status === 'closed') return WEEKLY_TEXT.statusClosed;
  if (status === 'resolved') return WEEKLY_TEXT.statusResolved;
  return WEEKLY_TEXT.statusHandled;
}

/** 下周计划优先级：doing 或 pri=1/2 → 高；pri=3 → 中；其余 → 低。 */
export function mapPriority(pri, status) {
  if (status === 'doing') return WEEKLY_TEXT.priorityHigh;
  const p = String(pri ?? '').trim();
  if (p === '1' || p === '2') return WEEKLY_TEXT.priorityHigh;
  if (p === '3') return WEEKLY_TEXT.priorityMedium;
  return WEEKLY_TEXT.priorityLow;
}

export function isActivePlanStatus(status) {
  return status === 'wait' || status === 'doing';
}

function toFiniteNumber(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** 完成工作原始行 → 周报条目。 */
export function mapFinishedTask(task) {
  const id = Number(task?.id ?? 0) || 0;
  const cleaned = cleanTaskTitle(task?.name);
  return {
    objectType: 'task',
    objectID: id,
    title: cleaned || `${WEEKLY_TEXT.itemFallback} ${id || ''}`.trim(),
    consumed: toFiniteNumber(task?.consumed),
    projectName: String(task?.projectName ?? '').trim(),
    executionName: String(task?.executionName ?? '').trim(),
    summary: cleaned,
  };
}

/** Bug 原始行 → 周报条目。 */
export function mapResolvedBug(bug) {
  return {
    id: Number(bug?.id ?? 0) || 0,
    title: String(bug?.title ?? '').trim(),
    status: mapBugStatus(bug?.status),
    projectName: String(bug?.projectName ?? '').trim(),
    executionName: String(bug?.executionName ?? '').trim(),
  };
}

/** 下周计划原始行 → 周报条目。 */
export function mapAssignedTask(task) {
  return {
    title: cleanTaskTitle(task?.name),
    priority: mapPriority(task?.pri, task?.status),
  };
}

/** 模板占位符按顺序替换（与参考项目 format 一致）。 */
export function fillTemplate(template, ...values) {
  let result = String(template);
  for (const value of values) {
    // 用函数替换：值里的 $& / $1 之类不能被 String.replace 当成替换模式解释。
    result = result.replace('%s', () => String(value));
  }
  return result;
}

/** 工作概述：项目名（去重、无则默认）+ 完成数 + Bug 数。 */
export function buildOverview(completedWorks, bugs) {
  const works = Array.isArray(completedWorks) ? completedWorks : [];
  const bugList = Array.isArray(bugs) ? bugs : [];
  const uniqueProjects = Array.from(new Set(works.map((item) => item?.projectName).filter(Boolean)));
  const mainProjects = uniqueProjects.length > 0 ? uniqueProjects.join('、') : WEEKLY_TEXT.defaultProjectSummary;
  return fillTemplate(WEEKLY_TEXT.overviewTemplate, mainProjects, works.length, bugList.length);
}

/** 工作总结：完成数 + 总工时 + 前 3 项工作 + Bug 数 + 前 2 项计划。 */
export function buildSummary(completedWorks, bugs, nextWeekPlan) {
  const works = Array.isArray(completedWorks) ? completedWorks : [];
  const bugList = Array.isArray(bugs) ? bugs : [];
  const plans = Array.isArray(nextWeekPlan) ? nextWeekPlan : [];
  const totalHours = works.reduce((sum, item) => sum + (Number(item?.consumed) || 0), 0);
  const keyWorks = works.slice(0, 3).map((item) => item?.title).filter(Boolean).join('、')
    || WEEKLY_TEXT.summaryDefaultWork;
  const keyPlans = plans.slice(0, 2).map((item) => item?.title).filter(Boolean).join('、')
    || WEEKLY_TEXT.summaryDefaultPlan;
  return fillTemplate(
    WEEKLY_TEXT.summaryTemplate,
    works.length,
    totalHours.toFixed(1),
    keyWorks,
    bugList.length,
    keyPlans,
  );
}

/** 'YYYY-MM-DD' → 'M月D日'（参考 formatChineseDate）。 */
export function formatChineseDate(value) {
  const d = parseDateOnly(value);
  if (!d) return String(value ?? '');
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 本地当前日期 'YYYY/MM/DD'。 */
export function formatReportDate(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/**
 * 由原始接口数据构建周报草稿（不写禅道）。
 * @param {{profile?:object, works?:unknown, bugs?:unknown, plans?:unknown, start:string, end:string, now?:number|Date}} input
 *   works = finishedBy 任务行；bugs = resolvedBy Bug 行；plans = assignedTo 任务行。
 */
export function buildWeeklyDraft({ profile, works, bugs, plans, start, end, now } = {}) {
  const completedWorks = normalizeCollection(works)
    .filter((task) => isDateInRange(task?.finishedDate, start, end))
    .map(mapFinishedTask)
    .sort((a, b) => b.objectID - a.objectID);

  const bugItems = normalizeCollection(bugs)
    .filter((bug) => isDateInRange(bug?.resolvedDate, start, end))
    .map(mapResolvedBug)
    .sort((a, b) => a.id - b.id);

  const nextWeekPlan = normalizeCollection(plans)
    .filter((task) => Boolean(String(task?.name ?? '').trim()) && isActivePlanStatus(task?.status))
    .map(mapAssignedTask);

  const realname = String(profile?.realname ?? '').trim();
  const account = String(profile?.account ?? '').trim();

  return {
    basicInfo: {
      reportPeriod: `${formatChineseDate(start)} ${WEEKLY_TEXT.rangeJoiner} ${formatChineseDate(end)}`,
      reporter: realname || account || '未知',
      department: WEEKLY_TEXT.department,
      reportDate: formatReportDate(now),
    },
    overview: buildOverview(completedWorks, bugItems),
    completedWorks,
    bugs: bugItems,
    summary: buildSummary(completedWorks, bugItems, nextWeekPlan),
    nextWeekPlan,
  };
}

/** 周报差异/空白占位（导出与前端展示同文案）。 */
export const WEEKLY_EMPTY_TEXT = Object.freeze({
  works: '本周暂无可汇总的完成工作',
  bugs: '本周暂无 Bug 处理记录',
  plans: '下周计划待补充',
});
