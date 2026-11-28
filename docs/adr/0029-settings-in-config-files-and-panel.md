# 0029 — 配置落入 `pretty-task.json` 与面板配置视图，环境变量冻结为最高覆盖层

## 状态

已接受（2026-11-28）

## 背景

`pi-pretty-task` 的十项运行期配置（输出上限、并发上限、通知开关、保留天数、前台改道开关与超时，以及两套平台的 shell 与路径）此前全部只从 `process.env` 的 `PI_PRETTY_TASK_*` 读取；而项目级 `<project>/.pi/pretty-task.json` 与全局 `$PI_CODING_AGENT_DIR/pretty-task.json` 只承载 `"templates"`。

只靠环境变量有两个痛点：
- 环境变量适合单次 shell 或宿主覆盖，却不适合按项目沉淀配置，也无法在会话进行中直观查看“某项配置当前是多少、来自哪一层、改了能不能立刻生效”；
- 若继续往 `process.env` 加键，配置面会拆成两套互不相通的入口。

因此需要将十项配置纳入现有的两层 `pretty-task.json` 并由 `/tasks` 面板直接查看和编辑，同时把十个既有 `PI_PRETTY_TASK_*` 环境变量冻结为兼容与最高优先级覆盖层（未来新增配置项只进 `pretty-task.json`，不再新增环境变量）。

## 决策

### 文件复用与顶层 Schema

复用现有的两层配置文件：
- 项目级：`<project>/.pi/pretty-task.json`
- 全局（agent 设置目录）：`$PI_CODING_AGENT_DIR/pretty-task.json`（默认 `~/.pi/agent/pretty-task.json`）

文件顶层为 JSON 对象，仅允许两个顶层键：`"settings"` 与 `"templates"`。出现任何其他顶层键即作为配置错误拒绝，避免把顶层拼写错误或放错层级的配置键静默吞掉。

`"settings"` 下支持十个字段，与冻结的十个 `PI_PRETTY_TASK_*` 环境变量一一对应：

| JSON 字段 (`settings.*`) | 环境变量 | 平台 | 合法值 | 默认值 |
|---|---|---|---|---|
| `outputCapBytes` | `PI_PRETTY_TASK_OUTPUT_CAP_BYTES` | 全部 | 正安全整数（字节） | `20971520` |
| `maxRunningTasks` | `PI_PRETTY_TASK_MAX_RUNNING_TASKS` | 全部 | 正安全整数（任务数） | `20` |
| `notify` | `PI_PRETTY_TASK_NOTIFY` | 全部 | `"on"`、`"off"` | `"on"` |
| `retentionDays` | `PI_PRETTY_TASK_RETENTION_DAYS` | 全部 | 正安全整数（天数） | `7` |
| `adoptForeground` | `PI_PRETTY_TASK_ADOPT_FOREGROUND` | 全部 | `"on"`、`"off"` | `"off"` |
| `foregroundTimeoutSeconds` | `PI_PRETTY_TASK_FOREGROUND_TIMEOUT` | 全部 | `0..2147483` 的安全整数（秒） | `0` |
| `shell` | `PI_PRETTY_TASK_SHELL` | Windows | `"cmd"`、`"bash"` | `"bash"` |
| `shellPath` | `PI_PRETTY_TASK_SHELL_PATH` | Windows | 绝对路径字符串 | 无（自动搜寻） |
| `posixShell` | `PI_PRETTY_TASK_POSIX_SHELL` | POSIX | `"inherit"`、`"bash"`、`"sh"` | `"bash"` |
| `posixShellPath` | `PI_PRETTY_TASK_POSIX_SHELL_PATH` | POSIX | 绝对可执行文件路径字符串 | 无（自动搜寻） |

两个开关项在 JSON 与 TUI 中统一使用 `"on"` / `"off"`，与环境变量和报错口径保持一致；前台改道超时命名为 `foregroundTimeoutSeconds`，与 `templates.<name>.timeoutSeconds` 的单位后缀对齐。

### 四层优先级与 `shell` + `shellPath` 原子配对

配置按四层优先级合成：
- `env`（`process.env` 中的 `PI_PRETTY_TASK_*`）
- `project`（`<project>/.pi/pretty-task.json` 的 `"settings"`）
- `agent`（`$PI_CODING_AGENT_DIR/pretty-task.json` 的 `"settings"`）
- `default`（内置默认值）

前六个标量项按字段独立取第一个给出定义的层。

当前平台的 `(*Shell, *ShellPath)`（Windows 为 `shell` + `shellPath`，POSIX 为 `posixShell` + `posixShellPath`）作为**单层内成对、跨层整组覆盖**的原子对处理：
- **同层配对校验**：在 `env`、`project`、`agent` 任意一层内，只要给出了 `*ShellPath`，同一层必须同时给出对应的 `*Shell`；只给路径不给 shell 直接报错（`... is set without ...`），禁止跨层借用另一层的 `*Shell`。
- **跨层整组决胜**：按 `env` > `project` > `agent` > `default` 找到第一个定义了 `*Shell` 的层，整组采用该层的 `(*Shell, *ShellPath)`。若该决胜层未写 `*ShellPath`，则对该层选定的 shell 执行默认搜寻（Windows 上 `bash` 按五级来源自动找 `bash.exe`、`cmd` 取 `ComSpec`；POSIX 上找 `/bin/<name>` 与 `PATH`），绝不继承更低层的 `*ShellPath`——防止下层为 `bash` 配的 `bash.exe` 路径被上层的 `shell: "cmd"` 误拿去按 `/d /s /c` 启动。

### 校验失败策略：`readSettings()` 严格阻断

延续 ADR-0008 与 `readSettings()` 的入口契约：
- 两层 `pretty-task.json` 文件不存在时视为该层无配置；
- 一旦文件存在，只要 JSON 语法损坏、顶层不是对象、顶层含未知键，或 `"settings"` 不是对象、含未知键、类型错误（如数字写成字符串或布尔值）、数值越界、包含非当前平台的 shell 键、或 `*ShellPath` 未在同层配对 `*Shell`，`readSettings()` 立即 `throw Error`（指明文件路径、键名、接受范围与实际值），阻断扩展加载；
- 只有文件 JSON 与 `"settings"` 均合法、而 `"templates"` 子树内存在字段错误时，仍由 `loadTemplates()` 走 `reportProblem` 写 stderr 并按文件降级模板。

### 面板配置视图（`mode = "settings"`）、来源标记与热生效边界

遵循 ADR-0005 与 ADR-0012，`PANEL_TABS` 保持 `Processes`、`Loops`、`Chains` 三页不变（三页只列三类 Task 根记录，共享 `f` 过滤、`/` 搜索、`o` 跨会话与 `k/a` 终止）。配置界面作为 `TasksPanel` 的子模式 `mode = "settings"`：
- 在列表页按 `s`（页脚 `LIST_KEYS` 增列 `s settings`）进入配置视图，`←` 返回任务列表，`alt+q` 关闭面板；
- 展示当前平台适用的八项配置（六项通用 + 当前平台的两项 shell 配置），每行显示：配置项名、当前生效值、生效来源（`env` / `project` / `agent` / `default`）、当前目标作用域文件中的值，以及是否需要 `/reload`；
- 目标文件作用域默认是 `project`（`<project>/.pi/pretty-task.json`），按 `t`（或 `Tab`）在 `project` 与 `agent`（`$PI_CODING_AGENT_DIR/pretty-task.json`）间切换；
- 对枚举/开关项（`notify`、`adoptForeground`、`shell` / `posixShell`）按 `Enter`（或 `Space`）切换并落盘；对数值/路径项按 `Enter` 进入行内编辑（`Enter` 校验落盘，`Esc` 取消）；按 `d`（或 `Backspace`）清除当前目标文件中该项的设定（清除 `shell` / `posixShell` 时一并清除同层的 `shellPath` / `posixShellPath`）；
- 当某项的生效来源为 `env` 时，行内与保存提示显式标明该项正被环境变量遮蔽（文件修改已落盘，但需移除对应环境变量后才生效）。

保存后的生效边界按运行期组件生命周期切分：
- **当前会话立即生效（六项）**：`outputCapBytes`、`maxRunningTasks`、`shell` + `shellPath`（或 `posixShell` + `posixShellPath`）在保存后立即重算并更新 `ProcessTasks`（作用于后续新启动的进程任务）；`notify` 立即更新 `TerminalNotifications`；`foregroundTimeoutSeconds` 立即更新 `ForegroundRunner`。
- **需 `/reload` 生效（两项，界面固定标注 `requires /reload`）**：`adoptForeground`（决定 `createExtension` 启动时是否 `registerTool` 覆盖 `bash`/`powershell` 及注册 `user_bash`）与 `retentionDays`（仅在 `session_start` 清理旧会话时读取一次）。

### 原子写回与保留 `"templates"`

配置写回统一经由 `src/tasks/base/atomic.ts` 的 `writeAtomic`：
- 先读取目标 `pretty-task.json`（不存在则视为空对象 `{}` 并确保父目录存在；若文件已存在但 JSON 损坏或顶层非对象，则拒绝写入并在面板报错，绝不覆盖损坏文件导致 `"templates"` 丢失）；
- 仅更新或删除顶层 `"settings"` 键（当该层 `"settings"` 的所有字段均被清除时移除 `"settings"` 键），原样保留同文件内的 `"templates"`；
- 落盘后重跑 `readSettings()` 完成校验与内存热更新。

## 不变的东西

- `src/tasks/base/settings.ts` 仍是全仓库唯一读取 `process.env` 键的模块；
- 十个既有 `PI_PRETTY_TASK_*` 环境变量的名字、取值格式与最高优先级不变，未来不再新增任何环境变量；
- 面板的 `1/2/3` 标签页与 Task 根记录模型（ADR-0012）不变。
