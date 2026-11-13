# 参考上游行为，重写代码结构

`pi-background-tasks` 与 `@trevonistrevon/pi-loop` 的源码只作为**行为参考**，不 fork、不复制类结构。凡是踩出来的细节（Windows `cmd.exe /d /s /c` 调用方式、`windowsVerbatimArguments`、POSIX 进程组、`taskkill /PID n /T`、SIGTERM 宽限后强杀并轮询确认整组消失）逐条照搬行为；文件划分与抽象重新设计。

## Considered Options

- **fork 上游仓库**：改动快，但继承其 4000 行单文件 registry、`dist/` 入库、peer 版本锁等历史包袱。
- **参考行为重写（采用）**：结构干净，代价是必须逐个复现那些“不写下来就会再踩一次”的平台细节。

## Consequences

- 该文书记录的每个平台细节必须落成代码注释，否则后人重构时会当成冗余删掉。
- 行为回归没有上游测试可用，v0.1 的验收五条（见 `docs/scope-v1.md`）就是回归基线。
