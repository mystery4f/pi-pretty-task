# 配置与上限

本文档说明当前的配置面：命令在哪个 shell 里跑、输出字节上限、`pretty_task_bg_run` 每次可以自带的运行超时/工作目录/环境变量，以及按名字复用的命令模板。上限与超时都以“终止原因”收尾，见 `GLOSSARY.md` 的 Process task 条目；shell 与解码的决定见 `docs/adr/0008-shell-choice-and-output-decoding.md`，默认 shell 与 `bash.exe` 的查找顺序见 `docs/adr/0022-bash-by-default-and-where-git-lives.md`。

## 命令在哪个 shell 里跑

`pretty_task_bg_run` 的 `command` 不是一条跨平台的“shell 脚本”，它交给当前平台选定的 shell。默认都是 bash——Windows 用 Git for Windows 的 `bash.exe`，POSIX 用 `/bin/bash`——可以整体换掉，也可以只换一次调用：

| 平台 | 默认 | 可选 |
|---|---|---|
| Windows | Git for Windows 的 `bash.exe -c "<command>"`，`bash.exe` 按下面的顺序找 | `cmd`、`bash` |
| POSIX | `/bin/bash -c "<command>"`（非登录 shell） | `inherit`、`bash`、`sh` |

语法要跟着 shell 走。bash 写 `for i in 1 2 3 4 5; do echo "tick $i"; sleep 2; done`，cmd 写 `for /L %i in (1,1,5) do @echo tick %i`。把 cmd 语法喂给默认的 bash 会得到 `syntax error near unexpected token '%i'`，把 bash 语法喂给设了 `PI_PRETTY_TASK_SHELL=cmd` 的 Windows 会得到 `此时不应有 i`——状态 `failed`、退出码不是 0，这不是任务失败，是命令写错了方言。

连接符尤其容易骗人：bash 里 `&` 是丢到后台，cmd 里 `&` 是顺序执行，同一条 `echo A & ping -n 11 127.0.0.1 >nul & echo B` 在 bash 下 A、B 立刻都打印、ping 还在后台跑，在 cmd 下约 10 秒后才打印 B。写 bash 时把顺序执行写成 `;` 或 `&&`，别指望 `&` 跨方言同义。

### 四个键

| 键 | 平台 | 取值 | 默认 |
|---|---|---|---|
| `PI_PRETTY_TASK_SHELL` | Windows | `cmd`、`bash` | `bash` |
| `PI_PRETTY_TASK_SHELL_PATH` | Windows | 绝对路径，给上一条点名的 shell 用 | 无（`cmd` 取 `ComSpec`，`bash` 按下面的顺序找） |
| `PI_PRETTY_TASK_POSIX_SHELL` | POSIX | `inherit`、`bash`、`sh` | `bash` |
| `PI_PRETTY_TASK_POSIX_SHELL_PATH` | POSIX | 绝对路径，且必须是可执行文件 | 无（先找 `/bin/<name>`，再找 PATH） |

Windows 上的 `bash.exe` 按这个顺序找，第一个存在的就用：pi 从 Git Bash 里启动时，用它那份 Git 的 `bin\bash.exe`（看 `EXEPATH` 和 `SHELL`）；否则看 `where git` 报告的每个 `git.exe` 旁边的 `<Git>\bin\bash.exe`；否则看注册表 `HKLM`、`HKCU` 下 `SOFTWARE\GitForWindows` 的 `InstallPath`；否则看 `%ProgramFiles%\Git`、`%ProgramFiles(x86)%\Git`、`%LOCALAPPDATA%\Programs\Git`；最后才在 PATH 上找 `bash.exe`、`bash.com`。只用 `bin\bash.exe`，不用 `usr\bin\bash.exe`：前者自己会把 `mingw64\bin` 和 `usr\bin` 放进 PATH，后者不会，`git`、`grep` 这些命令就找不到。

Windows 上退回 cmd（没装 Git for Windows 的机器必须这样写，否则加载时报下面那条找不到 bash 的错）：

```
set PI_PRETTY_TASK_SHELL=cmd
```

自动找到的 bash 不合意时（比如机器上装了好几份 Git），用单独的键点一个路径（两个键成对出现，只给路径不给 shell 是错误）：

```
set PI_PRETTY_TASK_SHELL=bash
set PI_PRETTY_TASK_SHELL_PATH=D:\Git\bin\bash.exe
```

POSIX 上跟登录 shell 走（`$SHELL` 为空时用 `/bin/sh`），或者干脆钉死一个 sh：

```
export PI_PRETTY_TASK_POSIX_SHELL=inherit
```

```
export PI_PRETTY_TASK_POSIX_SHELL=sh
```

取值在扩展加载时校验一次，错误信息带上键名、收到的值和可选项，例如：

```
PI_PRETTY_TASK_SHELL does not accept "zsh"; on win32 it is one of: cmd, bash
PI_PRETTY_TASK_POSIX_SHELL_PATH is set without PI_PRETTY_TASK_POSIX_SHELL; it only supplies the path of the shell that key names
```
PI_PRETTY_TASK_SHELL=bash (the default on Windows) needs bash.exe; searched the Git Bash pi was started from [nothing]; bash beside the git on PATH [nothing]; Git for Windows as registered [nothing]; the usual install directories [nothing]; PATH [bash.exe and bash.com in PATH "C:\Windows\system32"]; set PI_PRETTY_TASK_SHELL=cmd to keep cmd.exe, or PI_PRETTY_TASK_SHELL_PATH to the bash.exe to use

**不做静默兜底**：找不到 bash 就加载失败并说明搜过哪里，而不是悄悄退回 cmd——退回会让一条 bash 命令在 cmd 里跑，报错却指向另一件事。默认既然是 bash，一台没装 Git for Windows 的 Windows 机器要在 `.env` 里写 `PI_PRETTY_TASK_SHELL=cmd`，错误信息也会这样指路。平台之外的键同样是错误（在 Windows 上设 `PI_PRETTY_TASK_POSIX_SHELL` 没人读，就当配置错误报出来）。

### 只换一次调用

`pretty_task_bg_run` 的 `shell` 取 `default`、`cmd`、`bash`、`sh`：`default`（不给也一样）跟随上面的配置，其余取值直接点名一个 shell。平台不支持的取值当场拒绝，信息列出该平台允许的取值，任务不会创建：

```
shell "sh" is not available on win32; use one of: default, cmd, bash
```

`inherit` 不在 `pretty_task_bg_run` 的取值里——它是“跟随平台默认”的配置意图，一次调用则应该点名具体 shell。

### 编码

输出按字节原样落盘，不做转码；读回来的时候才解码，顺序是：先严格按 UTF-8，能解就是它；解不了且开头是续字节（读到的尾巴切在字符中间）就去掉最多 3 个续字节再试；仍然解不了时，Windows 按 GB18030（GBK 的超集，中文控制台的代码页）解码，POSIX 保持 UTF-8 有损解码（丢掉坏字节、留下 `�`）。POSIX 不猜老代码页：那里非法 UTF-8 更可能是二进制而不是 GBK。

所以 Windows 上 `ping` 之类按代码页写中文的控制台程序，中文能读回来；要 UTF-8 仍然可以 `chcp 65001` 或让命令自己输出 UTF-8。

## 输出字节上限

| 项 | 值 |
|---|---|
| 环境变量 | `PI_PRETTY_TASK_OUTPUT_CAP_BYTES` |
| 默认值 | `20971520`（20 MiB） |
| 合法值 | 大于 0 的安全整数（字节数） |

一个 process task 的输出文件最多写入这么多字节。跨过上限的那个 chunk 会先按剩余空间截断写入，之后到达的 chunk 直接丢弃——文件精确停在上限，超出的内容不会落盘。与此同时，任务按与 `pretty_task_bg_kill` 完全相同的路径终止：先礼后兵，整棵进程树一起处理。任务最终状态为 `killed`，终止原因为 `output_cap`，`pretty_task_bg_status` 与 `pretty_task_bg_logs` 都会显示 `kill reason: output_cap`。

恰好写满上限而没有丢弃任何字节的任务不算超限，照常记 `completed`。

### 非法值

启动时解析一次，解析失败就让扩展加载失败，错误信息带上键名、接受的形状和实际收到的值，例如：

```
PI_PRETTY_TASK_OUTPUT_CAP_BYTES must be a positive whole number of bytes; received "lots"
```

pi 会把这条信息报告为 “Failed to load extension: …”。**不做静默纠正**：`Number("lots")` 得到 `NaN`，而任何字节数与 `NaN` 比较都是 `false`，上限会永远看起来“已到达”，每个任务在第一个字节就被杀掉。上游正是这个缺陷，这里在入口处拦住。

## 运行超时

`pretty_task_bg_run` 接受可选的 `timeoutSeconds`：正数秒，最多 `2147483.647`（`setTimeout` 能计量的最长延迟，超过会被 Node 折成 1ms，等于立刻超时）。到点后走同一个 `stop` 路径，状态 `killed`，终止原因 `timeout`，`pretty_task_bg_status` 与 `pretty_task_bg_logs` 同样显示 `kill reason: timeout`。非法值（`0`、负数、`NaN`、`Infinity`）在启动进程之前就被拒绝，任务不会创建。

**没有默认超时。** v0.1 的验收要求一条 10 分钟的长任务不被杀掉，默认超时与这条验收直接冲突；需要上限的调用方自己给出秒数。
## 同时运行的任务上限

| 项 | 值 |
|---|---|
| 环境变量 | `PI_PRETTY_TASK_MAX_RUNNING_TASKS` |
| 默认值 | `20` |
| 合法值 | 大于 0 的安全整数（任务数） |

`docs/scope-v1.md` 承诺每个会话同时最多 20 个 running 的 process task，这个键就是那条上限。计数只数记录：一个会话里状态为 `running` 的 process 记录，子任务也算——`pretty_task_bg_run` 的 child、cmd loop 的一次 fire（父任务是一条 loop）、chain 的一个 step（父任务是一条 chain）都是 process 记录，所以它们共享同一个上限（ADR-0014）。loop 的上限（50）数的是调度，不是进程，两者互不抵消。

三处入口都要过这道门：

- `pretty_task_bg_run` 在创建记录**之前**被拒绝，错误信息就是这条上限，工具再补一句 `The task was not started.`，所以拒绝不会留下一条说不清来历的记录。
- 一次 fire 被拒绝时，fires 历史里那一条记为 `failed`，`error` 是这条上限，并计入连续失败次数；它不会停在 `pending`。
- 一个 chain step 拿不到名额时，这个 step 记为 `failed`、原因写在它的 `error` 里，chain 随这个 step 结束为 `failed`，原因引用这个 step，后面的 step 记为 `skipped`。

拒绝信息同时给出上限和这个键名：`This session already has 20 running process tasks; the limit is 20 (PI_PRETTY_TASK_MAX_RUNNING_TASKS). Stop one with pretty_task_bg_kill before starting another.` 一条 fire 和一条 step 都在看不见的地方失败，用户读到的就是这条记录，所以它必须自己说清楚是谁拦的、怎么放开。

`0`、负数、小数与拼错的值在加载时被拒绝（与其他键同样的报错形状），不会等到第一次 `pretty_task_bg_run` 才暴露：把上限读成 `NaN` 会让比较永远成立，所有任务在开始时就被拒绝，而用户完全看不出是哪个键造成的。

## 终端通知

| 项 | 值 |
|---|---|
| 环境变量 | `PI_PRETTY_TASK_NOTIFY` |
| 默认值 | `on` |
| 合法值 | `on`、`off` |

task 结束时向终端的 stdout 写一条 OSC 9 转义：

```
ESC ] 9 ; <任务名> <结束状态> BEL
```

例如 `nightly build` 正常结束写出的字节是 `\u001b]9;nightly build completed\u0007`。只有 `completed`、`failed`、`killed`、`interrupted` 这四个结束状态会写；还在跑或暂停的 task 一条也不写；`PI_PRETTY_TASK_NOTIFY=off` 时同样一条也不写。一个 task 结束恰好写一条。

**“只在没聚焦时通知”做不到。** 终端是否在前台、有没有被别的窗口挡住，从扩展这一侧都观察不到：没有 API，没有可靠的转义查询，也不该去问。所以规则与 issue #15 一致——总是写，由终端自己决定怎么处理。

终端的处理方式：

- 支持通知的终端（iTerm2、Windows Terminal、WezTerm、kitty、Ghostty 等）会弹一条系统通知，里面的任务名与状态就是这条字符串带来的。
- 不认识 OSC 9 的终端按终端规范丢弃这条字符串：既不显示，也不会把字节打印到屏幕上。这就是“不支持通知的终端不被打扰”的全部代价——什么都没有发生。
- 一条转义被限制在 200 字节以内：任务名会被截断，结束状态永远完整。名字里的控制字节（包括 ESC 与 BEL）先被换成空格，否则一个 BEL 会提前结束字符串、一个 ESC 会开始第二条转义；连续空白折成一个空格；清洗后为空时用 `task`。中文名原样保留。

只在有 UI 的会话里写：`ctx.hasUI` 为真的会话才可能写，headless 与 `print`、`json` 模式一条也不写。默认写入点还要求 `process.stdout.isTTY === true`，所以 `pi | tee` 这类把 stdout 接进管道的运行不会往管道里混进转义字节。

没有外部进程，也没有新依赖：字节就是全部机制。会话里的完成通知照旧发送，终端转义只是额外的一层——终端不响应时信息也不会丢。
## 旧会话清理

| 项 | 值 |
|---|---|
| 环境变量 | `PI_PRETTY_TASK_RETENTION_DAYS` |
| 默认值 | `7` |
| 合法值 | 大于 0 的安全整数（天数） |

一个会话的记录文件与它的全部输出文件住在同一个目录里：`<项目根>/.pi/tasks/<会话 id>/`，其中 `tasks.json` 是记录、`<任务 id>.output` 是每个 process task 的输出。所以“旧”是目录的属性——目录的修改时间在这些文件每次落盘时都会前移——清理一个旧会话就是删掉这一个目录：记录和输出一起消失，不留半份。

目录不是会话一开始就建的：只有这个会话真的写进第一条记录时（启动第一个 process task 时，它的输出文件也落在同一个目录里）才创建。只开一个会话、什么都没跑，就不留空目录——读记录与清理都按“目录不存在”这件事处理，不依赖它先存在。

目录住着的任何一个 task 还没结束（`running`、`paused`、`interrupted`），或者它是一条还会继续触发的 loop，整个目录都留下；当前会话自己的目录无论多旧都留下。记录文件读不出来（坏 JSON、本版本不认识的形状）时同样留下并报告，不猜——保留一个目录只花磁盘，删掉一个活着的目录花的是用户的历史。清理之后那个任务 id 就空出来了，后来的任务可以再用它。

**输出文件先一步不在了也不要紧。** 统计字节时文件在就计入、不在就贡献 0，一条记录不会因为输出文件已丢失而被永久保留：目录照常删除，字节数按实际剩下的算。

一次清理删掉了东西，就在 stderr 上说一次，不逐个文件列举：

```
pi-pretty-task: pruned 3 sessions, 1.4 MiB
```

读不了或删不掉的目录各占一行（`kept <目录名>: …`），清理继续进行，扩展不会被它挡住：

```
pi-pretty-task: kept 7f3c1a9e: its records could not be read
```

清理**只在会话开始时跑一次**，没有定时器。代价与目录数量成正比而不是与文件数量成正比：只对超过窗口的目录才去读记录、统计字节，其余每个目录只花一次 `stat`，所以 `.pi/tasks` 里堆了很多会话也不会拖慢第一次工具调用。

### 非法值

与输出上限一样，启动时解析一次，解析失败就让扩展加载失败：

```
PI_PRETTY_TASK_RETENTION_DAYS must be a positive whole number of days; received "1.5"
```

`0`、负数、小数、`week` 这类拼写都拒绝：`0` 会在每次会话开始时把除当前会话外的历史全部删掉，小数和拼写错误则更可能是笔误。**不做静默纠正**——一个悄悄变成 `NaN` 的窗口会让每次比较都是 `false`，看起来像“永远不清理”，用户却以为自己设了。

## 每次调用的目录与环境变量

`pretty_task_bg_run` 每次调用可以自带 `cwd` 和 `env`，只影响这次派生出来的子进程：

| 参数 | 形状 | 作用 |
|---|---|---|
| `cwd` | string | 命令在哪个目录里跑 |
| `env` | `{ [名字]: string }` | 只给这个子进程的环境变量 |

`cwd` 按会话工作目录解析：相对路径拼在会话目录后面，绝对路径原样使用，没给就用会话目录。最终使用的绝对路径写进任务记录，面板与 `pretty_task_bg_status` 都显示它，之后不再重新解析。目录必须存在且确实是目录，否则在创建任务记录之前就拒绝，错误信息带上解析后的路径，例如：

```
Working directory /work/project/no-such-dir does not exist. The task was not started.
```

`env` 合并到扩展自身的 `process.env` 之上，只作用于这个子进程；空字符串也是值，可以把变量清空。`undefined` 或非字符串会被 schema 拒绝。**`env` 不落盘**：名字和值都不写进 `.pi/tasks/<session>/tasks.json`，也没有任何工具会把值打印出来——文件里的记录不是存放 token 的地方，而进程启动时已经拿到了它。

## 命名模板
`pretty_task_bg_run` 可以把一组常用参数写成模板，用一个名字代替整条命令。模板来自两个 `pretty-task.json`：项目文件优先，同名模板整个由项目文件覆盖；只写在 agent 文件里的名字照样可用。

| 位置 | 路径 |
|---|---|
| 项目 | `<项目根>/.pi/pretty-task.json` |
| agent 设置目录 | `$PI_CODING_AGENT_DIR/pretty-task.json`（默认 `~/.pi/agent/pretty-task.json`） |
形状：
```
{
  "templates": {
    "test": { "command": "npm test -- --run", "cwd": "packages/app", "timeoutSeconds": 600 }
  }
}
```
调用时只给模板名，命令、目录和超时都来自模板：
```
pretty_task_bg_run({ "template": "test" })
```
模板字段与 `pretty_task_bg_run` 的同名参数含义相同：`cwd` 仍按会话目录解析，`timeoutSeconds` 仍受上面的上限约束。调用里显式给出的 `command`、`cwd`、`timeoutSeconds` 优先于模板，模板不会悄悄盖掉它们。模板不携带 `env`，需要环境变量的调用自己传。
名字不存在时任务不会创建，错误信息列出当前已知的名字：
```
Unknown template "tset". Known templates: "lint", "test". The task was not started. Templates are read when the extension loads, so a file edited during this session applies only after /reload or a new session.
```
模板文件**只在扩展加载时读一次**。会话进行中改文件，当前会话里名字、命令、`pretty_task_bg_run` 的描述都不会变，新模板要等 `/reload` 或新会话才可用——工具描述与报错都写着这句，避免模型以为写了没生效。描述本身就是提示词前缀的一部分：文件内容一变，下次加载的描述文字就变，那一段缓存要重付一次；内容没变则逐字节相同，重载不花钱。增删流程与校验步骤见插件自带的 `skills/pretty-task-templates/SKILL.md`。
任一文件解析失败只影响该文件：错误写到 stderr，带上文件路径和具体位置（例如 `invalid JSON (...)`、`template "test".command must be a non-empty string`），扩展继续加载，另一个文件里的模板照常可用。

## 前台命令改道

默认关闭。打开后，本扩展用同名 `registerTool` 覆盖内置 `bash`、并接管 `!` 命令，命令由本扩展 spawn——只有自己 spawn 的进程才有句柄可接管（[ADR-0020](adr/0020-foreground-command-detaches-to-a-task.md)）。`powershell` 工具也由本扩展注册，但它跑的是 pi 自带的 PowerShell 操作（有 `pwsh` 用 `pwsh`，否则用 Windows PowerShell），不经过本扩展的进程，没有下面的改道；`defaultTools` 里没开 `powershell` 的会话只有这一个来源。之后两种触发器能把一条正在前台跑的命令改道成 Process task：

| 键 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `PI_PRETTY_TASK_ADOPT_FOREGROUND` | `on`、`off` | `off` | 覆盖内置 shell 工具并接管 `!` 命令 |
| `PI_PRETTY_TASK_FOREGROUND_TIMEOUT` | 正整数秒（上限 2147483），或 `0` | `0` | 前台命令跑到该秒数自动改道；`0` 为关 |

快捷键 `ctrl+shift+b` 只对唯一一条「在等」的命令生效，前台命令与阻塞调用（`pretty_task_bg_run` 带 `wait: true`，见 [ADR-0025](adr/0025-blocking-run-waits-inside-the-call.md)）合起来数：恰好一条才动手，两条以上只给一条提示。按键与改道开关无关——关闭覆盖的项目里它也注册，只是那时它只放走阻塞调用。改道的命令不重跑、不换 PID，输出继续写到 `.pi/tasks/` 下的任务文件；它计入同时运行的任务上限，撞上限时改道失败、命令留在前台继续跑。`PI_PRETTY_TASK_FOREGROUND_TIMEOUT` 与内置 `timeout` 参数是两件事：前者「放它走」，后者「到点就杀」，Esc 仍是杀。

改道发生时，两个读者各得一句话，两句话都写明**是谁**结束了这次等待——按键、到点，还是会话在退出。模型唯一的渠道是那次工具调用的返回，形状是 `↪ moved to <id> — <原因>。Still running in the background. Follow: … · Stop: …`，拿到它说明命令还在跑、不是失败；用户那边得到一张会话卡片（`pi.appendEntry` + `registerEntryRenderer`），带底色的标题行（记录 id 与 `held 40.0s`）、一个空行、同一条原因从句，以及 `follow` / `stop` 两行命令，内边距和底色由渲染器自己建的 `Box` 给。卡片随会话落盘，重载后照样画出来，而且**不进模型上下文**——工具返回已经说过同样的事实，再发一条消息就是重复一遍。随后状态行立刻重画。反过来，没有前台命令、并行不止一条、撞上任务上限这三种情况只提示用户，模型那边看到的是命令照旧在前台跑完——没有人请求改道，也就没有什么要对模型说。被 `wait: true` 放走的那一条拿到的是同一张卡：它没有 runner，卡由快捷键处理器自己落，原因从句同样是按键，工具返回同样以那句 `↪ moved to …` 收尾。

## 为什么配置只从一个地方读

所有由环境变量决定的东西——输出上限、同时运行的任务上限、shell 策略、通知开关、旧会话保留天数、agent 设置目录——都在 `src/tasks/base/settings.ts` 里读一次，合成一个 `Settings` 值交给需要它的模块；`src/tasks/process/limits.ts` 只剩与时间有关的数值校验，`src/tasks/process/shell.ts` 从传入的环境里解析，扩展只经 `Settings` 调用它。一个键一种形状——见 `docs/scope-v1.md`。这样测试可以把一份显式环境（或一个普通对象）交给扩展入口，宿主也可以用同样的方式传入，而“读哪里、什么时候校验”只有一个答案：某个模块自己再读一次 `process.env` 是缺陷，不是优化。

`PI_PRETTY_TASK_*` 里这个版本不认识的键同样是错误：

```
PI_PRETTY_TASK_NOTIFY_TIMEOUT is not a key this version reads; known keys: PI_PRETTY_TASK_OUTPUT_CAP_BYTES, PI_PRETTY_TASK_MAX_RUNNING_TASKS, PI_PRETTY_TASK_NOTIFY, PI_PRETTY_TASK_RETENTION_DAYS, PI_PRETTY_TASK_SHELL, PI_PRETTY_TASK_SHELL_PATH, PI_PRETTY_TASK_POSIX_SHELL, PI_PRETTY_TASK_POSIX_SHELL_PATH, PI_PRETTY_TASK_ADOPT_FOREGROUND, PI_PRETTY_TASK_FOREGROUND_TIMEOUT
```

拼错的名字不该变成一个用户以为生效、扩展却默默忽略的设置。唯一例外是命名模板：模板要跨会话复用，所以放在项目与 agent 的 `pretty-task.json`；它也按 `Settings` 给出的路径在扩展入口读一次、校验一次，坏文件只报告，不阻断加载。

## 上限如何落到进程上

上限与 shell 策略都来自同一个 `Settings`：扩展入口 `src/index.ts` 在注册任何工具之前调用 `readSettings()`，把环境读成 `Settings`，再按 `settings.templatePaths` 读模板文件；`settings.outputCapBytes`、`settings.maxRunningTasks` 与 `settings.shellPolicy` 交给 `ProcessTasks`，输出上限与 shell 进入 supervisor 的输出写入点与 `spawn` 调用，任务上限在 `start` 与 `launch` 之前数一次记录。`pretty_task_bg_run` 的 `shell` 在 `spawn` 之前解析完，不支持的取值不会留下一条跑不起来的记录。超限与超时都不引入第二套终止机制：它们只是带着原因调用 `ProcessTasks.stop()`，与 `pretty_task_bg_kill` 走同一条路。读输出时 `src/tasks/base/decode.ts` 是唯一解码点，`src/tasks/base/output.ts` 的尾巴读取与 `pretty_task_bg_logs` 的整段读取共用它。
