# dsh-zentao-panel：角色模式开发交接（Trae 继续）

> 交接时间：2026-11-25。工作区：`D:\project\dsh-zentao-panel`。
> 这是 **代码开发任务**，不是禅道任务；不要通过禅道 MCP 写任何禅道数据。

## 1. 目标

把禅道工作台扩展成「产品 / 开发 / 测试」三种角色模式：

- 登录页选择模式，登录后页头可切换，选择持久化；
- 开发模式完整保留原有能力（处理、新建对话、写用例、计划模式、Trae/DSH 下发、状态跟踪、批量、本地备注、会话关联等）；
- 测试模式新增：待验证/缺描述/缺需求筛选、测试分析、测试点清单、QA 日报；写用例继续走 Trae 的禅道 MCP；
- 产品模式新增：需求分析；
- 分析类动作只出分析结果，不修改代码、不直接写禅道。

## 2. 当前状态（已由 DSH 侧完成的部分）

`client/client.js` 已实现并通过 `test/client.mjs`：

- `ROLE_MODES`、`ROLE_QUICK_FILTERS`、`readRoleMode/saveRoleMode/normRole/roleMeta`；
- 登录页 `LoginView` 角色选择；
- `ZentaoPane` 的 `roleMode` / `changeRole` / 页头角色 select；
- 测试/产品快捷筛选（`verify/nodesc/nostory`）；
- 卡片和详情的「测试分析」「需求分析」按钮 + `openAssist`；
- `PURPOSE_META`、`DSH_PURPOSE_HEADERS`，DispatchDialog 的 purpose 泛化；
- `sendDispatch` / `dispatchToTrae` 的 purpose 传递与文案；
- `TestPointsPanel` + 测试点存储 helper；
- 测试模式页头「QA」日报按钮 + `buildQaDaily`；
- 新增角色、筛选、弹层、测试点、日报测试。

`lib/trae.mjs` 已新增：

- `TRAE_PURPOSES`；
- `buildTraePrompt({ purpose, taskFile, workspace, md, planMode })`，支持 `fix/testcases/test-analysis/requirement-review`；
- `doDispatch` 使用该函数；`purpose` 回传。

`lib/rpc.mjs` 已允许上述四种 purpose。

当前 `C:\Users\ZhouTao\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe test\client.mjs` **全部通过**。

## 3. 剩余任务（按顺序）

### 3.1 升级 RPC 渠道，避免旧路由冲突

原渠道（旧前缀）在运行时 DSH 里已挂载旧 host 代码，必须换新前缀。下列引用已统一改为 **`/dsh-ztp8-rpc`**（2026-11-25 周报功能上线后再次升级为 `/dsh-ztp9-rpc`）：

- `lib/rpc.mjs`：`const CHANNEL = ...` 及上方注释；
- `client/client.js`：顶部注释与 `var CHANNEL = ...`；
- `test/host.mjs`：所有旧渠道路径；
- `README.md`、`README.en.md`、`docs/architecture.md`、`CLAUDE.md` 中的渠道示例；
- 全仓已复查：不残留旧的渠道前缀。

**不要**由你重启 DSH 或执行 `plugin_manager`；DSH 侧会在你完成后做重载验证。

### 3.2 补 host 侧测试

在 `test/host.mjs` 或单独的小测试中加入 `buildTraePrompt` 的纯函数断言：

- `fix`：包含「定位并修改代码」；
- `testcases`：包含「禅道 MCP」；
- `test-analysis` / `requirement-review`：包含「不要修改代码」，且不包含「定位并修改代码」；
- `planMode: true`：字符串以 `/plan` 开头；
- 未知 purpose：回退到 `fix` 的提示语。

`buildTraePrompt` 位于 `lib/trae.mjs`，已导出，可直接 import。

### 3.3 全量检查与修复

- `node --check`：`lib/trae.mjs`、`lib/rpc.mjs`、`client/client.js`、`test/client.mjs`、`test/host.mjs`；
- `node test/client.mjs` 必须全绿；
- 如 `test/host.mjs` 可在无凭据环境运行，则运行；否则至少保证语法检查与 `buildTraePrompt` 单测。
- 检查是否有遗漏的 purpose 分支/文案/回归：
  - 现有开发「处理」、Trae 写用例、计划模式、批量、会话关联不能被破坏；
  - `testcases` 仍默认 Trae，仍提示 MCP 写禅道；
  - 分析类不写禅道。

### 3.4 代码审查（重点）

请实际阅读 `client/client.js` 的以下位置并检查：

- `ROLE_MODES` / `PURPOSE_META` / `TestPointsPanel`；
- `LoginView` 角色选择；
- `ZentaoPane` 的 `roleMode/changeRole`、mast role select、QfBar role；
- `CardItem` 和 `DetailView` 的角色按钮；
- `DispatchDialog` 的 purpose 标题/备注/按钮；
- `sendDispatch` 与 `dispatchToTrae`；
- `buildQaDaily` 与测试点 helper。

重点找：角色切换后 `qf` 残留、按钮在窄面板溢出、测试点本地存储坏数据、分析按钮误用写用例文案、未知 purpose 回落。

### 3.5 手工验收（在 DSH 侧完成）

你完成后，DSH 侧会：

- 将渠道升到 `/dsh-ztp8-rpc`，执行 `plugin_manager set_bundle false/true`；
- 验证 `POST http://127.0.0.1:<DSH端口>/dsh-ztp8-rpc/zentao.status` 返回 401；
- 刷新 DSH 页面，检查：
  - 登录页三角色选择；
  - 开发模式原功能不回归；
  - 测试模式筛选 / 测试分析 / 测试点 / QA 日报；
  - 产品模式需求分析。

如果手工验收发现问题，再回到本文件继续修。

## 4. 约束

- 保留开发模式的全部现有功能，角色只增加/重排入口，不删除。
- 分析类动作不改代码、不直接写禅道；写用例仍由 Trae 的禅道 MCP 完成。
- 不新增 npm 依赖；不修改 `package.json` 的发布配置。
- 不提交 git，不删除现有文件，不改与本次无关的 Trae 桥接/禅道读取逻辑。
- 中文文件使用 write/edit 工具保存为 UTF-8，不要用 PowerShell `Get-Content` + `Set-Content`（会把中文写坏）。
- 测试 Node 用：
  `C:\Users\ZhouTao\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
- 不尝试重启 DSH、不执行 `plugin_manager`；那是 DSH 侧的步骤。

## 5. 交付

完成后请报告：

1. 修改文件清单；
2. 测试命令和结果（至少 `test/client.mjs` 全绿，prompt 单测结果）；
3. 仍未解决/需要 DSH 侧手工验证的点；
4. 确认没有回退开发模式原有功能。
