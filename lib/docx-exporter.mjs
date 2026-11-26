// dsh-zentao-panel — 周报导出（host 半边）
//
// 优先用 docx@9 生成 .docx（版式对齐参考项目 electron/docx-exporter.ts）；
// 依赖缺失 / 导入失败 → 回退为 Word 可打开的兼容 HTML（.doc）。
// 只写本地文件，不写禅道；不把 token/密码/账号写进文档。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { WEEKLY_EMPTY_TEXT } from './weekly.mjs';

const FONT_FAMILY = '微软雅黑';
const BORDER_COLOR = 'D9D9D9';
const TITLE_COLOR = '333333';
const ACCENT_BLUE = '4472C4';
const SUMMARY_FILL = 'E8F4F8';
const STRIPE_FILL = 'F2F2F2';
const LABEL_FILL = 'F8F8F8';
const WHITE = 'FFFFFF';

/** 默认输出目录：$DSH_HOME/zentao-panel/reports（默认 ~/.dsh/zentao-panel/reports）。 */
export function defaultReportsDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'zentao-panel', 'reports');
}

/** outputDir 必须是已存在的绝对目录（防路径穿越；不存在由调用方决定报错还是回退）。 */
export function assertOutputDir(outputDir) {
  if (typeof outputDir !== 'string' || !outputDir.trim()) throw new Error('导出目录不能为空');
  if (!isAbsolute(outputDir)) throw new Error('导出目录必须是绝对路径');
  let stat;
  try { stat = statSync(outputDir); } catch { throw new Error('导出目录不存在'); }
  if (!stat.isDirectory()) throw new Error('导出路径不是目录');
  return outputDir;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function stampOf(now) {
  const d = now instanceof Date ? now : new Date(now ?? Date.now());
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 不覆盖已有文件：同秒重复导出自动加 -2 / -3 后缀。 */
function uniquePath(dir, base, ext) {
  let path = join(dir, `${base}${ext}`);
  for (let i = 2; existsSync(path) && i < 1000; i++) path = join(dir, `${base}-${i}${ext}`);
  return path;
}

function totalHours(draft) {
  return (draft.completedWorks || []).reduce((sum, item) => sum + (Number(item?.consumed) || 0), 0).toFixed(1);
}

// ───────────────────────── .docx（docx@9）─────────────────────────

function buildDocxDocument(docx, draft) {
  const {
    AlignmentType, BorderStyle, Document, HeadingLevel, Paragraph, ShadingType,
    Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
  } = docx;

  const textRun = (text, options = {}) => new TextRun({
    text: String(text ?? ''),
    bold: options.bold,
    size: options.size ?? 22,
    color: options.color,
    font: FONT_FAMILY,
  });
  const accentRun = (text, color) => textRun(text, { bold: true, color });
  const allBorders = () => ({
    top: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
    left: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
    right: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR },
  });
  const hiddenBorders = () => ({
    top: { style: BorderStyle.NONE, size: 0, color: WHITE },
    bottom: { style: BorderStyle.NONE, size: 0, color: WHITE },
    left: { style: BorderStyle.NONE, size: 0, color: WHITE },
    right: { style: BorderStyle.NONE, size: 0, color: WHITE },
  });

  const sectionTitle = (text) => new Paragraph({
    heading: HeadingLevel.HEADING_2,
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT_BLUE } },
    spacing: { before: 280, after: 120 },
    children: [textRun(text, { bold: true, size: 24, color: ACCENT_BLUE })],
  });

  const summaryBlock = (lines) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [new TableRow({
      children: [new TableCell({
        shading: { fill: SUMMARY_FILL, type: ShadingType.CLEAR, color: 'auto' },
        borders: hiddenBorders(),
        children: lines.map((line) => new Paragraph({
          spacing: { before: 40, after: 40 },
          children: [textRun(line || '无')],
        })),
      })],
    })],
  });

  const introParagraph = (children) => new Paragraph({ spacing: { after: 100 }, children });

  const infoLabelCell = (text) => new TableCell({
    width: { size: 20, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: { fill: LABEL_FILL, type: ShadingType.CLEAR, color: 'auto' },
    borders: allBorders(),
    children: [new Paragraph({ spacing: { before: 20, after: 20 }, children: [textRun(text, { bold: true })] })],
  });
  const valueCell = (text, width) => new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    borders: allBorders(),
    children: [new Paragraph({ spacing: { before: 20, after: 20 }, children: [textRun(text || '-')] })],
  });

  const basicInfoTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ children: [
        infoLabelCell('报告周期'),
        valueCell(draft.basicInfo.reportPeriod, 30),
        infoLabelCell('报告人'),
        valueCell(draft.basicInfo.reporter, 20),
      ] }),
      new TableRow({ children: [
        infoLabelCell('部门'),
        valueCell(draft.basicInfo.department, 30),
        infoLabelCell('报告日期'),
        valueCell(draft.basicInfo.reportDate, 20),
      ] }),
    ],
  });

  const headerCell = (text, width) => new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: { fill: ACCENT_BLUE, type: ShadingType.CLEAR, color: 'auto' },
    borders: allBorders(),
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 30, after: 30 },
      children: [textRun(text, { bold: true, color: WHITE })],
    })],
  });
  const stripedCell = (text, width, striped) => new TableCell({
    width: { size: width, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.CENTER,
    shading: striped ? { fill: STRIPE_FILL, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    borders: allBorders(),
    children: [new Paragraph({ spacing: { before: 20, after: 20 }, children: [textRun(text || '-')] })],
  });
  const stripedTable = (headers, rows, widths) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => headerCell(h, widths[i])) }),
      ...rows.map((row, rowIndex) => new TableRow({
        children: row.map((value, i) => stripedCell(value, widths[i], rowIndex % 2 === 1)),
      })),
    ],
  });

  const workRows = draft.completedWorks.length > 0
    ? draft.completedWorks.map((item, i) => [String(i + 1), item.title, `${(Number(item.consumed) || 0).toFixed(1)}h`])
    : [['1', WEEKLY_EMPTY_TEXT.works, '-']];
  const bugRows = draft.bugs.length > 0
    ? draft.bugs.map((item, i) => [String(i + 1), item.title, item.status])
    : [['1', WEEKLY_EMPTY_TEXT.bugs, '-']];
  const planRows = draft.nextWeekPlan.length > 0
    ? draft.nextWeekPlan.map((item, i) => [String(i + 1), item.title, item.priority])
    : [['1', WEEKLY_EMPTY_TEXT.plans, '中']];

  return new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 320 },
          children: [textRun('开发周报', { bold: true, size: 32, color: TITLE_COLOR })],
        }),
        sectionTitle('一、基本信息'),
        basicInfoTable,
        sectionTitle('二、工作概述'),
        summaryBlock([draft.overview]),
        sectionTitle('三、完成的主要工作'),
        introParagraph([
          textRun('本周共完成 '),
          accentRun(`${draft.completedWorks.length} 项`, '2E7D32'),
          textRun(' 任务，总计工时 '),
          accentRun(`${totalHours(draft)} 小时`, '1565C0'),
        ]),
        stripedTable(['序号', '工作内容', '工时'], workRows, [12, 68, 20]),
        sectionTitle('四、Bug 修复情况'),
        introParagraph([
          textRun('本周共处理 '),
          accentRun(`${draft.bugs.length} 个`, 'C62828'),
          textRun(' Bug'),
        ]),
        stripedTable(['序号', '问题描述', '状态'], bugRows, [12, 68, 20]),
        sectionTitle('五、工作总结'),
        summaryBlock([draft.summary]),
        sectionTitle('六、下周工作计划'),
        stripedTable(['序号', '计划事项', '优先级'], planRows, [12, 68, 20]),
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          spacing: { before: 360 },
          children: [
            textRun(`汇报时间：${draft.basicInfo.reportDate}`, { color: '666666' }),
            textRun('    '),
            textRun(`汇报人：${draft.basicInfo.reporter}`, { color: '666666' }),
          ],
        }),
      ],
    }],
  });
}

// ───────────────────── .doc（Word 兼容 HTML 回退）─────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraphHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function buildDocHtml(draft) {
  const works = draft.completedWorks.length > 0
    ? draft.completedWorks.map((item, i) => `<tr><td class="c">${i + 1}</td><td>${escapeHtml(item.title)}</td><td class="c">${(Number(item.consumed) || 0).toFixed(1)}h</td></tr>`).join('')
    : `<tr><td class="c">1</td><td>${escapeHtml(WEEKLY_EMPTY_TEXT.works)}</td><td class="c">-</td></tr>`;
  const bugs = draft.bugs.length > 0
    ? draft.bugs.map((item, i) => `<tr><td class="c">${i + 1}</td><td>${escapeHtml(item.title)}</td><td class="c">${escapeHtml(item.status)}</td></tr>`).join('')
    : `<tr><td class="c">1</td><td>${escapeHtml(WEEKLY_EMPTY_TEXT.bugs)}</td><td class="c">-</td></tr>`;
  const plans = draft.nextWeekPlan.length > 0
    ? draft.nextWeekPlan.map((item, i) => `<tr><td class="c">${i + 1}</td><td>${escapeHtml(item.title)}</td><td class="c">${escapeHtml(item.priority)}</td></tr>`).join('')
    : `<tr><td class="c">1</td><td>${escapeHtml(WEEKLY_EMPTY_TEXT.plans)}</td><td class="c">中</td></tr>`;

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>开发周报</title>
<style>
body{font-family:"${FONT_FAMILY}","Microsoft YaHei",sans-serif;font-size:10.5pt;color:${TITLE_COLOR};margin:24pt;}
h1{font-size:16pt;text-align:center;margin:0 0 18pt;}
h2{font-size:12pt;color:${ACCENT_BLUE};border-bottom:1pt solid ${ACCENT_BLUE};padding-bottom:3pt;margin:14pt 0 6pt;}
table{border-collapse:collapse;width:100%;margin:4pt 0 8pt;}
th{background:${ACCENT_BLUE};color:#fff;font-weight:bold;border:0.5pt solid ${BORDER_COLOR};padding:4pt;text-align:center;}
td{border:0.5pt solid ${BORDER_COLOR};padding:4pt;vertical-align:middle;}
td.c{text-align:center;}
tr:nth-child(even) td{background:${STRIPE_FILL};}
.info td{background:#fff;}
.info td.label{background:${LABEL_FILL};font-weight:bold;width:15%;}
.summary{background:${SUMMARY_FILL};border:none;padding:6pt 8pt;margin:4pt 0 8pt;}
.foot{text-align:right;color:#666;margin-top:16pt;}
</style>
</head>
<body>
<h1>开发周报</h1>
<h2>一、基本信息</h2>
<table class="info">
<tr><td class="label">报告周期</td><td>${escapeHtml(draft.basicInfo.reportPeriod)}</td><td class="label">报告人</td><td>${escapeHtml(draft.basicInfo.reporter)}</td></tr>
<tr><td class="label">部门</td><td>${escapeHtml(draft.basicInfo.department)}</td><td class="label">报告日期</td><td>${escapeHtml(draft.basicInfo.reportDate)}</td></tr>
</table>
<h2>二、工作概述</h2>
<div class="summary">${paragraphHtml(draft.overview || '无')}</div>
<h2>三、完成的主要工作</h2>
<p>本周共完成 <b style="color:#2E7D32">${draft.completedWorks.length} 项</b> 任务，总计工时 <b style="color:#1565C0">${totalHours(draft)} 小时</b>。</p>
<table><tr><th style="width:12%">序号</th><th style="width:68%">工作内容</th><th style="width:20%">工时</th></tr>${works}</table>
<h2>四、Bug 修复情况</h2>
<p>本周共处理 <b style="color:#C62828">${draft.bugs.length} 个</b> Bug</p>
<table><tr><th style="width:12%">序号</th><th style="width:68%">问题描述</th><th style="width:20%">状态</th></tr>${bugs}</table>
<h2>五、工作总结</h2>
<div class="summary">${paragraphHtml(draft.summary || '无')}</div>
<h2>六、下周工作计划</h2>
<table><tr><th style="width:12%">序号</th><th style="width:68%">计划事项</th><th style="width:20%">优先级</th></tr>${plans}</table>
<p class="foot">汇报时间：${escapeHtml(draft.basicInfo.reportDate)}　　汇报人：${escapeHtml(draft.basicInfo.reporter)}</p>
</body>
</html>
`;
}

/**
 * 导出周报到本地文件。
 * @param {{draft:object, outputDir?:string, now?:number|Date, loadDocx?:Function}} options
 *   loadDocx 可注入（测试模拟依赖缺失）；默认动态 import('docx')。
 * @returns {Promise<{path:string, format:'docx'|'doc', bytes:number}>}
 */
export async function exportWeeklyReport({ draft, outputDir, now, loadDocx } = {}) {
  if (!draft || !draft.basicInfo) throw new Error('周报草稿为空，无法导出');
  // 用户选的目录必须已存在；默认目录允许自动创建
  const custom = typeof outputDir === 'string' && outputDir.trim();
  const dir = custom ? assertOutputDir(outputDir.trim()) : defaultReportsDir();
  mkdirSync(dir, { recursive: true });
  const base = `开发周报-${stampOf(now)}`;

  try {
    const loader = typeof loadDocx === 'function' ? loadDocx : () => import('docx');
    const docx = await loader();
    const doc = buildDocxDocument(docx, draft);
    const buffer = await docx.Packer.toBuffer(doc);
    const path = uniquePath(dir, base, '.docx');
    writeFileSync(path, buffer);
    return { path, format: 'docx', bytes: buffer.length };
  } catch {
    // docx 依赖缺失/生成失败 → Word 兼容 HTML（.doc），Word 可直接打开
    const html = buildDocHtml(draft);
    const buffer = Buffer.from(html, 'utf8');
    const path = uniquePath(dir, base, '.doc');
    writeFileSync(path, buffer);
    return { path, format: 'doc', bytes: buffer.length };
  }
}
