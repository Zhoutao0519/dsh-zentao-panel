# 开发模式彩蛋：生成周报（Weekly Report）开发交接

> 交接时间：2026-11-25。工作区：`D:\project\dsh-zentao-panel`。
> 参考项目：`D:\Desktop\chandao\`（Electron 周报助手）。
> 这是 **代码开发任务**，不是禅道任务；不要通过禅道 MCP 写任何禅道数据。

## 1. 目标

在 **开发模式** 的禅道面板页头增加一个「彩蛋」入口 **「生成周报」**（截图目标位置：角色下拉框左侧）。点击后：

1. 选择/确认周报时间范围（默认本周一至周日）；
2. 复用当前已登录的禅道账号，自动拉取本周完成的任务、解决的 Bug、下周待办；
3. 生成可编辑的周报草稿（基本信息 + 工作概述 + 完成工作 + Bug 修复 + 工作总结 + 下周计划）；
4. 支持编辑、重新生成概述/总结、复制 Markdown、导出 Word（`.docx`）；
5. 全程只读，不写禅道。

### 成功标准

- 只有 `roleMode === 'dev'` 时显示「生成周报」；测试/产品模式不显示。
- 默认时间范围是当前自然周（周一 00:00 至周日 23:59:59，本地时区）。
- 使用当前激活的禅道账号，无需重新登录；数据来自参考项目已验证的接口。
- 周报包含参考项目的六个区块，工时、Bug 状态、下周计划优先级口径一致。
- 草稿可编辑；可重新生成概述/总结；可复制 Markdown；可导出 `.docx`。
- 导出的 `.docx` 能在 Word 中正常打开，中文字体/表格/标题正常。
- 不写禅道，不泄露账号密码/Token；不影响现有开发/测试/产品模式功能。

## 2. 参考项目与已验证口径

参考目录：

- `D:\Desktop\chandao\docs\chandao-weekly-report-api.md`：接口与字段口径（必读）；
- `D:\Desktop\chandao\electron\chandao-service.ts`：数据拉取、过滤、模板、状态/优先级映射；
- `D:\Desktop\chandao\electron\docx-exporter.ts`：周报 `.docx` 排版；
- `D:\Desktop\chandao\electron\types.ts`：数据模型；
- `D:\Desktop\chandao\src\App.tsx`：编辑 UI 与文案；
- `D:\Desktop\chandao\docs\prd.md`：周报字段与验收标准。

### 2.1 数据接口（当前实例已验证）

认证：

- `POST /api.php/v1/tokens`（JSON `{account,password}`）→ `{token}`（HTTP 201）；
- `GET /api.php/v1/user`（Header `Token: <token>`）→ `profile.id/account/realname`。

页面 JSON（需要登录态 Cookie）：

- 完成的主要工作：
  `GET /user-task-{userId}-finishedBy-id_desc-839-100-1.json`
  - 顶层 `data` 是 JSON 字符串，二次 parse 后取 `tasks[]`；
  - 字段：`id/name/consumed/status/finishedDate/pri/projectName/executionName`；
  - 按 `finishedDate` 落在 `[start 00:00:00, end 23:59:59]` 过滤。
- Bug 修复情况：
  `GET /user-bug-{userId}-resolvedBy-id_desc-3042-1000-1.json`
  - 顶层 `data` 二次 parse 后取 `bugs[]`；
  - 字段：`id/title/status/resolvedDate/projectName/executionName`；
  - 按 `resolvedDate` 过滤。
- 下周工作计划：
  `GET /user-task-{userId}-assignedTo-status_asc-5159-20-1.json`
  - 顶层 `data` 二次 parse 后取 `tasks[]`；
  - 只保留 `status` 为 `wait` 或 `doing`；
  - 不按时间范围过滤（表示当前待推进任务）。

> 参考口径：时间范围只影响「完成的主要工作」和「Bug 修复情况」；下周计划始终取当前组织模块下进行中/未开始任务。

### 2.2 字段映射

- 报告周期：`M月D日 至 M月D日`（用户选择范围）；
- 报告人：`profile.realname`（拿不到时用账号）；
- 部门：固定「研发部」；
- 报告日期：本地当前日期 `YYYY/MM/DD`；
- 完成工作：`title <- name`，`consumed <- consumed`，按事项 ID 倒序；
- Bug 状态：`closed -> 已关闭`、`resolved -> 已解决`、其他 -> `已处理`；
- 下周计划优先级：
  - `status === 'doing'` 或 `pri` 为 1/2 → 高；
  - `pri === '3'` → 中；
  - 其他 → 低；
- 任务标题清洗：去掉开头的 `前缀:` / `前缀：` 和 `YYYY.N` 前缀（参考 `cleanTaskTitle`）。

### 2.3 文本模板

工作概述模板：

```
本周主要围绕 %s 展开工作，累计完成 %s 项主要任务，处理 %s 个 Bug，并持续推进在研需求与交付支持。
```

工作总结模板：

```
本周共完成 %s 项工作，累计工时 %s 小时。重点推进了 %s，并处理 %s 个 Bug。下周将继续围绕 %s 展开。
```

占位符依次填入：项目名（无则「当前负责项目」）、完成数、Bug 数；完成数、总工时、前 3 个完成事项、Bug 数、前 2 个下周计划。

### 2.4 `.docx` 版式

参考 `docx-exporter.ts`：

- 标题「开发周报」居中；
- 一、基本信息（报告周期/报告人/部门/报告日期，两行表格）；
- 二、工作概述（浅蓝底块）；
- 三、完成的主要工作（序号/工作内容/工时，斑马纹表格）；
- 四、Bug 修复情况（序号/问题描述/状态）；
- 五、工作总结（浅蓝底块）；
- 六、下周工作计划（序号/计划事项/优先级）；
- 页脚右对齐：汇报时间 + 汇报人；
- 字体「微软雅黑」，标题/表头主色 `4472C4`，边框 `D9D9D9`。

## 3. 现有插件可复用能力

- `lib/zentao-client.mjs`：
  - 已有 Cookie jar、`ensureLogin` 所需的 `login`/`restore`；
  - 已有 `fetchV1Token(account, password)` 和 `request(path, {ajax, referer, headers})`；
  - 已有 `fetchMyWork`/`fetchDetail`。
- `lib/service.mjs`：
  - 每个账号 session 闭包内已有 `account/password`、`client`、`ensureLogin`；
  - 可在 session 上新增 `fetchWeeklyReport`；
  - 聚合服务可新增 `fetchWeeklyReport`。
- `lib/rpc.mjs`：
  - 当前渠道 `/dsh-ztp8-rpc`，新增 endpoint 即可。
- `client/client.js`：
  - 已有角色模式、mast、`uiWorkspace.pickDirectory()`、`copyToClipboard`、toast、弹层样式；
  - 已有一个 `DispatchDialog` 可作为弹层风格参考，但周报弹层独立实现。

## 4. 后端设计

### 4.1 新模块 `lib/weekly.mjs`

建议新建纯函数模块，便于单测：

```js
parseEmbeddedJson(data)        // 二次 JSON.parse
normalizeCollection(value)     // 数组或对象值 → 数组
isDateInRange(value,start,end) // 本地时区，含边界
cleanTaskTitle(name)           // 参考 cleanTaskTitle
mapBugStatus(status)
mapPriority(pri,status)
buildOverview(works, bugs)
buildSummary(works, bugs, plans)
buildWeeklyDraft({profile, works, bugs, plans, start, end, now})
validateRange(start, end)
```

报告模型：

```ts
{
  basicInfo: { reportPeriod, reporter, department, reportDate },
  overview: string,
  completedWorks: [{ objectType, objectID, title, consumed, projectName, executionName, summary }],
  bugs: [{ id, title, status, projectName, executionName }],
  summary: string,
  nextWeekPlan: [{ title, priority }]
}
```

建议使用原生 `Date`/`Intl`，不新增 `dayjs`（除非已有）。

### 4.2 `lib/service.mjs`

在 `createAccountSession` 内新增：

```js
async function fetchWeeklyReport({ start, end }) {
  await ensureLogin();
  // 1) v1 token + user profile
  const token = await client.fetchV1Token(account, password);
  const res = await client.request('/api.php/v1/user', {
    headers: { Token: token, Accept: 'application/json' },
  });
  const profile = (await res.json()).profile; // 或 JSON.parse(await res.text())
  // 2) 三个页面接口并行拉取
  const [finished, resolved, assigned] = await Promise.all([...]);
  // 3) 解析 data 字符串、归一化、过滤、构建 draft
  return buildWeeklyDraft({...});
}
```

实现要点：

- 页面接口用 `client.request(path, { ajax: true, referer: baseUrl + '/my.html' })`；
- 响应是 `{data: "<json string>"}`，用 `parseEmbeddedJson` 二次 parse；
- `tasks`/`bugs` 可能是数组或按 id 索引的对象，统一 `normalizeCollection`；
- token 只用于 `/api.php/v1/user`，不要传给页面接口或写入日志；
- 任一页面接口失败：返回对应空区块 + `warnings`，不要整单失败；认证失败才报错；
- `ensureLogin()` 已有会话失效自动重登；
- 不新增账号持久化字段；密码/Token 不返回给 client。

聚合服务新增：

```js
async function fetchWeeklyReport({ start, end }) {
  return mustActive().fetchWeeklyReport({ start, end });
}
```

并在返回对象中导出。

### 4.3 `lib/rpc.mjs`

新增 endpoint：

- `weekly: 'zentao.weekly'`
- `weeklyExport: 'zentao.weeklyExport'`

校验：

- `start/end` 必须是 `YYYY-MM-DD`；
- `start <= end`；
- 范围建议 ≤ 31 天；
- `weeklyExport` 接收 `draft` + `outputDir?`，校验 draft 形状、数组长度（≤ 200）、字符串长度（≤ 20000）；
- `outputDir` 必须是已存在的绝对目录；写入固定文件名，防路径穿越；
- 返回 `{ path, format, bytes }`。

### 4.4 `lib/docx-exporter.mjs`

- 端口参考 `docx-exporter.ts`，保持六段结构与样式；
- **新增依赖**：`docx@^9.5.1`（参考项目同版本），在 `package.json` 增加 `dependencies.docx`；
- 使用动态 `await import('docx')`，避免依赖缺失时整个插件加载失败；
- 依赖不可用/导入失败时：
  - 回退为 **Word 兼容 HTML `.doc`**（UTF-8、`<table>`、内联样式），Word 可直接打开；
  - 仍返回路径和格式 `doc`，前端 toast 说明使用了兼容格式；
  - 可选同时写一份 `.md` 便于复制。
- 默认输出目录：`~/.dsh/zentao-panel/reports/`；
- 文件名：`开发周报-YYYYMMDD-HHmmss.docx`（或 `.doc`）；
- 写入前 `mkdirSync(..., { recursive: true })`；不覆盖已有文件；写入返回字节数；
- 不把 token/密码/账号写进文档。

> 如果安装 `docx` 依赖不可接受，保留 `.doc`/Markdown 回退作为 v1；但默认仍按参考项目实现 `.docx`。

## 5. 前端设计

### 5.1 开发模式彩蛋入口

- 在 `ZentaoPane` 的 mast 中，`roleMode[0] === 'dev'` 时显示：
  - `h('button', { className: 'ztp-weekly-btn', title: '开发模式彩蛋：生成周报' }, '✨ 生成周报')`
  - 位置：角色 select 左侧（截图目标位置）；
  - 测试/产品模式不渲染；
  - 未登录/未配置时 toast「先登录禅道」。
- 可点击 `Ctrl+Shift+W`？不需要，v1 只做按钮。

### 5.2 `WeeklyReportDialog`

独立组件，使用现有 `.ztp-disp-layer`/`.ztp-disp-pop` 风格但加宽（如 760px，窄屏 100%），内容可滚动。

状态：

```js
start/end        // 默认本周一/周日
draft            // WeeklyReportDraft | null
loading/error
exporting
outputDir
```

流程：

1. 顶部日期范围 + 「生成周报」；
2. 生成中 spinner；
3. 生成成功展示：
   - 基本信息表（只读）；
   - 工作概述 textarea + 「重新生成」；
   - 完成的主要工作：表格，工作内容/工时可编辑，行可删除，可新增；
   - Bug 修复情况：表格，ID/描述/状态可编辑，行可删除，可新增；
   - 工作总结 textarea + 「重新生成」；
   - 下周工作计划：事项/优先级可编辑，行可删除，可新增；
4. 底部按钮：
   - 「重新生成」：用当前完成工作/Bug/计划重算 overview/summary；
   - 「复制 Markdown」：`copyToClipboard`；
   - 「导出 Word」：`uiWorkspace.pickDirectory()` 选目录（取消则用默认目录），调用 `zentao.weeklyExport`；成功 toast 显示路径；
   - 「关闭」。
5. 日期校验：end < start 时禁用生成并提示。

编辑实现：

- 使用受控数组状态，所有编辑本地完成；
- `regenerate` 使用客户端同一套模板（与 host 一致）；
- 空数组时生成占位行/空态，导出仍有占位内容；
- 不把草稿写回禅道；可选 localStorage `dsh-zentao-panel.weekly.v1` 暂存，非必需。

### 5.3 Markdown 导出

生成结构：

```md
# 开发周报

## 一、基本信息
- 报告周期：...
- 报告人：...
- 部门：研发部
- 报告日期：...

## 二、工作概述
...

## 三、完成的主要工作
| 序号 | 工作内容 | 工时 |
...

## 四、Bug 修复情况
| 序号 | 问题描述 | 状态 |
...

## 五、工作总结
...

## 六、下周工作计划
| 序号 | 计划事项 | 优先级 |
...
```

### 5.4 CSS

新增：

- `.ztp-weekly-btn`（紧凑按钮，角色 select 左侧；窄面板可只显示 ✨+周报）；
- `.ztp-weekly-layer/pop`（宽弹层）；
- `.ztp-weekly-dates`、`.ztp-weekly-table`、`.ztp-weekly-row`、`.ztp-weekly-input`、`.ztp-weekly-section`、`.ztp-weekly-foot`；
- 表格横向滚动/窄屏换行；
- 继续使用 DSH token，不引入新 UI 库。

## 6. 错误与边界

- 未登录/无激活账号：提示先登录，不打开生成；
- `/api.php/v1/user` 拿不到 userId/realname：
  - 尝试用页面用户资料兜底；仍失败则提示「无法识别当前用户」；
- 三个页面接口任一失败：对应区块为空 + warning，报告仍可生成；
- 空数据：完成工作/Bug/下周计划显示占位行，导出有占位内容；
- 日期非法/范围过大：前端+host 双重校验；
- 禅道会话过期：沿用 host `ensureLogin` 自动重登；重登失败提示重新登录；
- 导出目录取消/不可写：回退默认目录或提示路径错误；
- `docx` 依赖缺失：导出 `.doc`/Markdown，toast 说明；
- 中文/超长标题：清洗、截断输入显示，不破坏表格；
- 安全：不写禅道、不把 Token/密码返回/记录/导出；输出目录固定文件名，防路径穿越；
- 角色隔离：只有开发模式显示入口；测试/产品模式现有功能不变。

## 7. 测试计划

### 后端
- `weekly.mjs` 纯函数：
  - 嵌套 `data` 解析、数组/dict 归一；
  - 日期边界（start 当天/end 当天/范围外）；
  - 标题清洗、Bug 状态映射、优先级映射；
  - overview/summary 模板占位符；
  - 空数据。
- `service` weekly：
  - mock client `fetchV1Token`/`request`/`fetchMyWork`，断言三次页面请求路径、Token Header、并行/错误处理；
  - 任一页面失败 → 空区块 + warning；
  - 不泄露 token/password。
- RPC：
  - 渠道 `/dsh-ztp9-rpc`（见下）；
  - `zentao.weekly` 参数校验、未知 method、非法日期；
  - `weeklyExport` draft 校验、输出目录、文件名、fallback。
- 导出：
  - 有 `docx` 时：生成临时文件，检查 `PK` 文件头/大小；
  - 无 `docx`/mock import 失败：回退 `.doc`，检查 HTML 头和内容；
  - 中文/空数据。

### 前端
- 角色 dev 显示「生成周报」；test/product 不显示；
- 默认本周一/周日（可注入 now）；
- 生成 RPC payload `{start,end}`；
- 编辑完成工作/Bug/计划、删除/新增；
- 重新生成概述/总结；
- 复制 Markdown；
- 导出：`pickDirectory` 调用/取消回退默认目录/导出成功 toast；
- 错误和 loading 状态；
- 空数据占位；
- 现有 client 测试全绿。

### 手工验收
1. 开发模式登录真实禅道，点「生成周报」；
2. 默认本周，生成成功；
3. 数据与参考项目 `D:\Desktop\chandao` 生成结果对比（完成工作、Bug、下周计划）；
4. 编辑几项，重新生成概述/总结，复制 Markdown；
5. 导出 `.docx`，用 Word 打开，检查中文/表格/标题；
6. 切到测试/产品模式，确认入口消失、原功能正常；
7. 确认禅道无新增/修改数据（只读）。

## 8. 实施顺序与文件

1. `lib/weekly.mjs`：纯函数 + fixture 测试；
2. `lib/service.mjs`：`fetchWeeklyReport`；
3. `lib/rpc.mjs`：`zentao.weekly` / `zentao.weeklyExport`；
4. `lib/docx-exporter.mjs` + `package.json` 的 `docx` 依赖 + fallback；
5. `client/client.js`：mast 彩蛋按钮 + `WeeklyReportDialog` + 编辑/导出；
6. `test/weekly.mjs`、`test/client.mjs`、`test/host.mjs`（或独立 prompt/rpc 测试）；
7. 渠道升级：`/dsh-ztp8-rpc` → **`/dsh-ztp9-rpc`**（`lib/rpc.mjs`、client、test/host、docs/CLAUDE 全量）；
8. `node --check`、`test/client.mjs`、`test/weekly.mjs`、`test/trae-prompt.mjs`；host 集成测试需 `DSH_HOME` scratch + 凭据；
9. **不要重启 DSH、不要执行 plugin_manager、不要提交 git**；完成后由 DSH 侧重载和刷新验收。

依赖安装：

```powershell
cd D:\project\dsh-zentao-panel
npm install docx@9.5.1 --save
```

如果安装失败或环境不允许新增依赖，保留 `.doc`/Markdown 回退，不阻塞功能。

## 9. 验收标准

- [ ] 开发模式页头出现「✨ 生成周报」，测试/产品模式没有；
- [ ] 默认当前自然周，可改起止日期；
- [ ] 真实账号生成成功，六个区块完整；
- [ ] 完成工作含工时，Bug 状态/下周优先级口径正确；
- [ ] 可编辑、增删、重新生成概述/总结；
- [ ] 可复制 Markdown；
- [ ] 可导出 `.docx`（或依赖缺失时 `.doc` 回退），Word 打开正常；
- [ ] 不写禅道、不泄露凭据；
- [ ] 现有开发/测试/产品功能与测试全部不回归。

## 10. 交付

完成后请报告：

1. 修改文件清单；
2. `node --check`、`test/client.mjs`、`test/weekly.mjs`、`test/trae-prompt.mjs` 结果；
3. 依赖安装情况（`docx` 是否安装成功）；
4. 手工导出文件路径/格式；
5. 仍需 DSH 侧重载/验收的点。
