# 配置与上限

本文档说明 v0.1 的全部配置面：一个经由环境变量给出的输出字节上限，以及 `bg_run` 每次可以自带的运行超时。两者都以“终止原因”收尾，见 `GLOSSARY.md` 的 Process task 条目。

## 命令在哪个 shell 里跑

`bg_run` 的 `command` 不是一条跨平台的“shell 脚本”，它交给当前平台的默认 shell：

| 平台 | 实际调用 | 该写哪种语法 |
|---|---|---|
| Windows | `cmd.exe /d /s /c "<command>"`（`ComSpec` 指向别的 shell 时用它） | cmd：`for /L %i in (1,1,5) do @echo tick %i` |
| POSIX | `sh -c "<command>"`（`-c`，非登录 shell） | sh：`for i in 1 2 3 4 5; do echo "tick $i"; sleep 2; done` |

拿 POSIX 语法喂 Windows 会得到 `此时不应有 i` 这类 cmd 报错，状态 `failed`、退出码 1——这不是任务失败，是命令写错了方言。v0.1 不提供 shell 选择参数；需要 PowerShell 或 bash 时把解释器写进命令里，例如 `powershell -NoProfile -Command "..."` 或 `bash -lc "..."`（后者要求 PATH 上有 bash）。

输出按字节原样追加，不做转码：Windows 控制台程序按系统代码页（中文环境通常是 GBK）写出中文报错，读回来就是乱码。要 UTF-8，开局 `chcp 65001` 或让命令自己输出 UTF-8。

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

## 为什么只有环境变量

配置只来自环境，一个键一种形状，没有配置文件方言——见 `docs/scope-v1.md`。这样测试可以把一份显式环境交给扩展入口，宿主也可以用同样的方式传入，而“读哪里、什么时候校验”只有一个答案。

## 上限如何落到进程上

上限由 `src/tasks/process/limits.ts` 解析，扩展入口 `src/index.ts` 在注册任何工具之前调用它，解析结果交给 `ProcessTasks`，由其传给 supervisor 的输出写入点。超限与超时都不引入第二套终止机制：它们只是带着原因调用 `ProcessTasks.stop()`，与 `bg_kill` 走同一条路。
