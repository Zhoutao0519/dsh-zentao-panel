# ZenTao Bridge（Trae CN 扩展）

这是给 `@zhoutao0519/dsh-zentao-panel` 用的**本地 Trae 桥接扩展**。

## 为什么需要它

Trae CN 3.4.20 的官方 `trae-cn chat` CLI 调用 VS Code 内置的
`workbench.action.chat.open`，但该命令在 Trae CN 的窗口里没有注册：
renderer 日志里是 `command 'workbench.action.chat.open' not found`。
表现就是：Trae 窗口被打开，但没有新对话、也没有禅道内容。

Trae 自己的 AI 面板命令是：

```
workbench.action.chat.icube.open
```

它接受 `{ query, newChat: true, keepOpen: true }`：新建 AI 对话并把 query
发出去。这个扩展运行在 Trae 的扩展宿主里，监听 `127.0.0.1` 上的一个小
HTTP 端口，收到 DSH 插件 POST 的任务后，调用上面的命令。

## 安装

把 `trae-bridge/` 目录复制到 Trae CN 的用户扩展目录：

```text
C:\Users\<你>\.trae-cn\extensions\local.zentao-bridge-0.0.1\
  package.json
  extension.js
```

然后在 Trae 中执行 **Developer: Reload Window**（或重启 Trae），让扩展宿主
加载它。加载成功后每个打开的 Trae 窗口会写一个注册文件：

```text
~/.trae-cn/zentao-bridge/registry/<workspace-hash>.json
```

DSH 插件会读取它，带 Bearer token POST 到对应端口。

## 接口

- `GET /ping` → `{ ok, workspace, pid }`
- `POST /dispatch`（需要 `Authorization: Bearer <token>`）
  ```json
  {
    "workspace": "D:\\project\\dsh-zentao-panel",
    "query": "请处理……",
    "images": ["D:\\...\\1.png"],
    "planMode": false
  }
  ```
  `planMode: true` 会通过 Trae 自己的 `/plan` 斜杠命令（`slashCommand`）发送，
  Trae 会先探索并给出方案，等用户批准后再动手；不会把 `/plan` 当普通文本塞进输入框。
  `images` 会被复制到工作区 `.trae/zentao/bridge-<时间>/images/`，并把
  相对路径追加到 query 末尾，方便 Trae 里的 agent 直接读取。

## 安全

- 只绑定 `127.0.0.1`。
- 每次激活生成随机 token，写入 0600 的注册文件。
- 只执行固定命令 `workbench.action.chat.icube.open`，不接受任意命令。
- 不读取、不保存任何 Trae token 或禅道凭据。
