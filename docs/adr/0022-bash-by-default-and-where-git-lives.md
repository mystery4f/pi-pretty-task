# 0022 — 默认用 bash，bash.exe 跟着用户的 git 找

## 状态

已接受（2026-11-23）

## 背景

ADR-0008 把 Windows 的默认 shell 定为 `cmd.exe`、POSIX 定为 `$SHELL`，并规定 bash 只在 PATH 上找 `bash.exe`/`bash.com`，找不到就报错、不猜安装位置。那时这个扩展只管 `pretty_task_bg_run`：命令由用户自己写，用 cmd 的人写 cmd，没有冲突。

ADR-0020 之后，`PI_PRETTY_TASK_ADOPT_FOREGROUND=on` 让扩展接管内置 `bash` 工具和 `!` 命令——工具名字叫 `bash`，写命令的却常常是模型。模型按名字和 pi 的文档写 POSIX 语法，命令却拿到 cmd 里跑：`cd /c/Users/…` 报「系统找不到指定的路径」，`$f="…"` 报「'$f' 不是内部或外部命令」，`echo $0` 原样打印 `$0`。2026-11-23 在作者机器上确认：`bash` 工具实际跑的是 `C:\Windows\system32\cmd.exe`。工具叫 bash 却跑 cmd，是文档和实现互相矛盾，不是用户配错。

同时作者在几台机器上 Git for Windows 装在不同盘（`G:\Git`、`D:\Soft\Git`），`settings.json` 里一条写死的 `shellPath` 换台机器就是死路径；pi 自己的解析（`dist/utils/shell.js`）对不存在的 `shellPath` 直接 throw，也不查注册表。

## 决策

**两个平台的默认 shell 都是 bash；Windows 上的 `bash.exe` 跟着用户的 Git 找，按顺序问五个来源，找到第一个存在的就用。**

- 来源顺序：pi 从 Git Bash 里启动时它那份 Git（`EXEPATH`、`$SHELL`）→ `where.exe git.exe` 报告的每个 `git.exe` 旁边的 `<Git>\bin\bash.exe` → 注册表 `HKLM\SOFTWARE\GitForWindows`、`HKLM\SOFTWARE\WOW6432Node\GitForWindows`、`HKCU\SOFTWARE\GitForWindows` 的 `InstallPath\bin\bash.exe` → `%ProgramFiles%\Git`、`%ProgramFiles(x86)%\Git`、`%LOCALAPPDATA%\Programs\Git` → PATH 上的 `bash.exe`、`bash.com`。来源按需展开：从 Git Bash 启动时既不跑 `where`，也不查注册表。
- `where git` 要遍历所有结果：Git for Windows 自己在 `mingw64\bin\git.exe` 和 `cmd\git.exe` 各放一份，前者的 `<Git>\mingw64\bin\bash.exe` 不存在，后者才有。每个 `git.exe` 旁边找 `bin\bash.exe`，最多上溯两层；`scoop`、`mise` 的 shim 后面没有 `bin\bash.exe`，探针会把它筛掉。
- 只用 `bin\bash.exe`，不用 `usr\bin\bash.exe`：实测 `bin\bash.exe` 是一个包装器，即使从一个没有 `MSYSTEM`/`EXEPATH` 的环境启动，它也会设 `MSYSTEM=MINGW64`、`EXEPATH=<Git>\bin`，并把 `mingw64\bin`、`usr\bin` 放进 PATH，`git`、`grep` 都找得到；`usr\bin\bash.exe` 不会，`git` 只剩 `/cmd/git`。`where bash.exe` 在 PATH 上报的恰好是 `usr\bin\bash.exe`，所以 PATH 只当最后一个来源。
- POSIX 默认 `bash`（先 `/bin/bash`，再 PATH）；`inherit` 和 `sh` 要显式选。`inherit` 仍是 `$SHELL`，为空时 `/bin/sh`。
- `cmd` 仍然可选：`PI_PRETTY_TASK_SHELL=cmd` 整体退回，`pretty_task_bg_run` 的 `shell: "cmd"` 单次点名。cmd 的调用形状 `/d /s /c "<command>"` 不变。
- 找不到 bash 仍在加载时报错，**不兜底**（沿用 ADR-0008 的原则）。错误信息标出这是默认值并指两条路：`set PI_PRETTY_TASK_SHELL=cmd to keep cmd.exe, or PI_PRETTY_TASK_SHELL_PATH to the bash.exe to use`，前面逐个来源列出搜过什么。一台没装 Git for Windows 的 Windows 机器必须显式写 `PI_PRETTY_TASK_SHELL=cmd`。
- `where.exe`、`reg.exe` 用 `%SystemRoot%\System32\` 下的绝对路径调用，不受 PATH 影响；两条探测经 `ShellPolicyOptions.run` 注入，测试不依赖机器上装了什么。
- `powershell` 工具：接管打开时仍由本扩展注册（pi 只在 `defaultTools` 里有它时才内置），但改成 `createPowerShellTool(cwd)` 不传 `operations`——它跑 pi 自带的 PowerShell 操作（`pwsh` 优先），不再借用策略 shell，也没有前台改道。之前传了 `operations`，pi 就跳过自己的 pwsh 配置，`powershell` 工具在 Windows 上实际跑的是 cmd。

## 代价

- 默认变了：以前不配置就是 cmd 的 Windows 用户，升级后命令在 bash 里跑。cmd 方言的命令（`cd /d`、`set X=`、`&` 顺序执行、`findstr`、`type`）会失败，错误信息也不再是 cmd 的。迁移就是一条 `PI_PRETTY_TASK_SHELL=cmd`；全局提示词里「Windows 上用 cmd 语法」的规则要同步改。
- 没装 Git for Windows 的 Windows 机器从「能跑」变成「加载报错」，必须显式选 `cmd`。作者判断这是对的方向：一个叫 `bash` 的工具在 cmd 里跑，比一个清楚的加载错误更坏。
- 加载时最多多两次子进程（`where.exe`、`reg.exe`），只在前面来源都为空时才跑；从 Git Bash 启动的常见路径一次都不跑。
- 发现逻辑有了机器差异：装了多份 Git 的机器，`where git` 的第一份胜出。要钉死就用 `PI_PRETTY_TASK_SHELL_PATH`。
- `powershell` 工具失去前台改道：在它里面跑的长命令 `ctrl+shift+b` 移不走。换来的是它真的是 PowerShell。

## 相关

- `src/tasks/process/shell.ts`：`findWindowsBash`、`findPosixShell`、`resolveShellPolicy`、`ShellPolicyOptions.run`。
- `src/tasks/base/settings.ts`：`SettingsOptions.run` 透传。
- `src/index.ts`：`powershell` 工具的注册方式。
- `test/integration/process-shell.test.ts`：五个来源各一条用例、默认值与错误信息。
- `docs/configuration.md`「命令在哪个 shell 里跑」。
- `docs/adr/0008-shell-choice-and-output-decoding.md`：默认值与 PATH 查找被本文取代。
- `docs/adr/0020-foreground-command-detaches-to-a-task.md`：接管内置工具的出处。
