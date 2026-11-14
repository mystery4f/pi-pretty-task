# 配置与上限

本文档说明 v0.1 的全部配置面：命令在哪个 shell 里跑、输出字节上限，以及 `bg_run` 每次可以自带的运行超时、工作目录与环境变量。上限与超时都以“终止原因”收尾，见 `GLOSSARY.md` 的 Process task 条目；shell 与解码的决定见 `docs/adr/0008-shell-choice-and-output-decoding.md`。

## 命令在哪个 shell 里跑

`bg_run` 的 `command` 不是一条跨平台的“shell 脚本”，它交给当前平台选定的 shell。默认是各平台的老样子，可以整体换掉，也可以只换一次调用：

| 平台 | 默认 | 可选 |
|---|---|---|
| Windows | `cmd.exe /d /s /c "<command>"`（`ComSpec` 指向别的 shell 时用它） | `cmd`、`bash` |
| POSIX | `"$SHELL" -c "<command>"`，`$SHELL` 为空时用 `/bin/sh`（`-c`，非登录 shell） | `inherit`、`bash`、`sh` |

语法要跟着 shell 走。cmd 写 `for /L %i in (1,1,5) do @echo tick %i`，bash 写 `for i in 1 2 3 4 5; do echo "tick $i"; sleep 2; done`。拿 POSIX 语法喂 Windows 的默认 shell 会得到 `此时不应有 i` 这类 cmd 报错，状态 `failed`、退出码 1——这不是任务失败，是命令写错了方言。

连接符尤其容易骗人：cmd 里 `&` 是顺序执行，bash 里 `&` 是丢到后台，同一条 `echo A & ping -n 11 127.0.0.1 >nul & echo B` 在 cmd 下约 10 秒后才打印 B，在 bash 下 A、B 立刻都打印、ping 还在后台跑。换 shell 时把 `&` 改成 `;` 或 `&&`，别指望它跨方言同义。

### 四个键

| 键 | 平台 | 取值 | 默认 |
|---|---|---|---|
| `PI_PRETTY_TASK_SHELL` | Windows | `cmd`、`bash` | `cmd` |
| `PI_PRETTY_TASK_SHELL_PATH` | Windows | 绝对路径，给上一条点名的 shell 用 | 无（`cmd` 取 `ComSpec`，`bash` 在 PATH 上找 `bash.exe`、`bash.com`） |
| `PI_PRETTY_TASK_POSIX_SHELL` | POSIX | `inherit`、`bash`、`sh` | `inherit` |
| `PI_PRETTY_TASK_POSIX_SHELL_PATH` | POSIX | 绝对路径，且必须是可执行文件 | 无（先找 `/bin/<name>`，再找 PATH） |

Windows 上改用 PATH 上的 bash：

```
set PI_PRETTY_TASK_SHELL=bash
```

bash 不在 PATH 上时，用单独的键给出路径（两个键成对出现，只给路径不给 shell 是错误）：

```
set PI_PRETTY_TASK_SHELL=bash
set PI_PRETTY_TASK_SHELL_PATH=D:\Git\bin\bash.exe
```

POSIX 上改用 bash，或者干脆钉死一个 sh：

```
export PI_PRETTY_TASK_POSIX_SHELL=bash
export PI_PRETTY_TASK_POSIX_SHELL_PATH=/usr/local/bin/bash
```

```
export PI_PRETTY_TASK_POSIX_SHELL=sh
```

取值在扩展加载时校验一次，错误信息带上键名、收到的值和可选项，例如：

```
PI_PRETTY_TASK_SHELL does not accept "zsh"; on win32 it is one of: cmd, bash
PI_PRETTY_TASK_POSIX_SHELL_PATH is set without PI_PRETTY_TASK_POSIX_SHELL; it only supplies the path of the shell that key names
```

**不做静默兜底**：找不到 bash 就加载失败并说明搜过哪里，而不是悄悄退回 cmd——退回会让一条 bash 命令在 cmd 里跑，报错却指向另一件事。平台之外的键同样是错误（在 Windows 上设 `PI_PRETTY_TASK_POSIX_SHELL` 没人读，就当配置错误报出来）。

### 只换一次调用

`bg_run` 的 `shell` 取 `default`、`cmd`、`bash`、`sh`：`default`（不给也一样）跟随上面的配置，其余取值直接点名一个 shell。平台不支持的取值当场拒绝，信息列出该平台允许的取值，任务不会创建：

```
shell "sh" is not available on win32; use one of: default, cmd, bash
```

`inherit` 不在 `bg_run` 的取值里——它是“跟随平台默认”的配置意图，一次调用则应该点名具体 shell。

### 编码

输出按字节原样落盘，不做转码；读回来的时候才解码，顺序是：先严格按 UTF-8，能解就是它；解不了且开头是续字节（读到的尾巴切在字符中间）就去掉最多 3 个续字节再试；仍然解不了时，Windows 按 GB18030（GBK 的超集，中文控制台的代码页）解码，POSIX 保持 UTF-8 有损解码（丢掉坏字节、留下 `�`）。POSIX 不猜老代码页：那里非法 UTF-8 更可能是二进制而不是 GBK。

所以 Windows 上 `ping` 之类按代码页写中文的控制台程序，中文能读回来；要 UTF-8 仍然可以 `chcp 65001` 或让命令自己输出 UTF-8。

## 输出字节上限

| 项 | 值 |
|---|---|
| 环境变量 | `PI_PRETTY_TASK_OUTPUT_CAP_BYTES` |
| 默认值 | `20971520`（20 MiB） |
| 合法值 | 大于 0 的安全整数（字节数） |

一个 process task 的输出文件最多写入这么多字节。跨过上限的那个 chunk 会先按剩余空间截断写入，之后到达的 chunk 直接丢弃——文件精确停在上限，超出的内容不会落盘。与此同时，任务按与 `bg_kill` 完全相同的路径终止：先礼后兵，整棵进程树一起处理。任务最终状态为 `killed`，终止原因为 `output_cap`，`bg_status` 与 `bg_logs` 都会显示 `kill reason: output_cap`。

恰好写满上限而没有丢弃任何字节的任务不算超限，照常记 `completed`。

### 非法值

启动时解析一次，解析失败就让扩展加载失败，错误信息带上键名、接受的形状和实际收到的值，例如：

```
PI_PRETTY_TASK_OUTPUT_CAP_BYTES must be a positive whole number of bytes; received "lots"
```

pi 会把这条信息报告为 “Failed to load extension: …”。**不做静默纠正**：`Number("lots")` 得到 `NaN`，而任何字节数与 `NaN` 比较都是 `false`，上限会永远看起来“已到达”，每个任务在第一个字节就被杀掉。上游正是这个缺陷，这里在入口处拦住。

## 运行超时

`bg_run` 接受可选的 `timeoutSeconds`：正数秒，最多 `2147483.647`（`setTimeout` 能计量的最长延迟，超过会被 Node 折成 1ms，等于立刻超时）。到点后走同一个 `stop` 路径，状态 `killed`，终止原因 `timeout`，`bg_status` 与 `bg_logs` 同样显示 `kill reason: timeout`。非法值（`0`、负数、`NaN`、`Infinity`）在启动进程之前就被拒绝，任务不会创建。

**没有默认超时。** v0.1 的验收要求一条 10 分钟的长任务不被杀掉，默认超时与这条验收直接冲突；需要上限的调用方自己给出秒数。

## 每次调用的目录与环境变量

`bg_run` 每次调用可以自带 `cwd` 和 `env`，只影响这次派生出来的子进程：

| 参数 | 形状 | 作用 |
|---|---|---|
| `cwd` | string | 命令在哪个目录里跑 |
| `env` | `{ [名字]: string }` | 只给这个子进程的环境变量 |

`cwd` 按会话工作目录解析：相对路径拼在会话目录后面，绝对路径原样使用，没给就用会话目录。最终使用的绝对路径写进任务记录，面板与 `bg_status` 都显示它，之后不再重新解析。目录必须存在且确实是目录，否则在创建任务记录之前就拒绝，错误信息带上解析后的路径，例如：

```
Working directory /work/project/no-such-dir does not exist. The task was not started.
```

`env` 合并到扩展自身的 `process.env` 之上，只作用于这个子进程；空字符串也是值，可以把变量清空。`undefined` 或非字符串会被 schema 拒绝。**`env` 不落盘**：名字和值都不写进 `.pi/tasks/<session>/tasks.json`，也没有任何工具会把值打印出来——文件里的记录不是存放 token 的地方，而进程启动时已经拿到了它。

## 为什么只有环境变量

配置只来自环境，一个键一种形状，没有配置文件方言——见 `docs/scope-v1.md`。这样测试可以把一份显式环境交给扩展入口，宿主也可以用同样的方式传入，而“读哪里、什么时候校验”只有一个答案。

## 上限如何落到进程上

上限由 `src/tasks/process/limits.ts` 解析，shell 策略由 `src/tasks/process/shell.ts` 解析；扩展入口 `src/index.ts` 在注册任何工具之前调用两者，解析结果交给 `ProcessTasks`，由其传给 supervisor 的输出写入点与 `spawn` 调用。`bg_run` 的 `shell` 在 `spawn` 之前解析完，不支持的取值不会留下一条跑不起来的记录。超限与超时都不引入第二套终止机制：它们只是带着原因调用 `ProcessTasks.stop()`，与 `bg_kill` 走同一条路。读输出时 `src/tasks/base/decode.ts` 是唯一解码点，`src/tasks/base/output.ts` 的尾巴读取与 `bg_logs` 的整段读取共用它。
