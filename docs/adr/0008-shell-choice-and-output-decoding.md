# 命令用哪个 shell 跑，输出按什么编码读

Windows 上 `bg_run` 默认走 `cmd.exe /d /s /c`（ADR-0004 定的），于是习惯 POSIX 的人写 `for i in 1..5; do …` 会直接失败，`cmd` 还把它读成乱码；`cmd` 控制台输出的 GBK 中文按 UTF-8 解也是乱码。两件事分开解决：shell 由用户显式选，编码在读的时候自动判断。

## Considered Options

- **只改文档**：零风险，但“我想用 bash 写一条命令”这种需求没出口，只能把整台机器的配置改掉。
- **只给 `bg_run` 加参数**：单次调用能选，但每次都要写一遍；`PI_PRETTY_TASK_*` 这一套环境变量已经存在，会话级默认值才是更自然的粒度。
- **只给环境变量**：和上游 `PI_BG_SHELL` 一致，迁移成本低，但同一个会话里（比如临时验证一条 POSIX 脚本）改不了。
- **环境变量定默认 + `bg_run.shell` 覆盖（采用）**：默认一次配好，个别调用再指定；两处最终都落到同一个解析函数，不存在第二套语义。
- **编码自动按 GBK 解（采用）**：只在 UTF-8 解码失败时回退到 `gb18030`（GBK 的超集）；磁盘上永远是原始字节，读取层决定怎么展示。

## Consequences

- 环境变量两个平台分开，名字跟着平台走：Windows `PI_PRETTY_TASK_SHELL=cmd|bash`（可选 `PI_PRETTY_TASK_SHELL_PATH` 绝对路径），POSIX `PI_PRETTY_TASK_POSIX_SHELL=inherit|bash|sh`（可选 `PI_PRETTY_TASK_POSIX_SHELL_PATH`）。默认分别是 `cmd` 与 `inherit`，不配置就与今天完全一样。
- 非法值在插件加载时立刻失败，错误信息带键名与该值；`*_SHELL_PATH` 单独出现也报错（它与 shell 是一对）。绝不静默回退到默认值 —— 配错了要当场知道。
- bash 从 `PATH` 里找 `bash.exe` / `bash.com`，找不到就报错并说明原因，不去猜 Git for Windows 的安装位置。
- `bg_run.shell` 取 `default | cmd | bash | sh`；`default` 表示用配置的默认值，平台不支持的值（如 Windows 上的 `sh`）在调用时被拒并列出该平台可用的值。`.js` 层不加额外的 shell 路径参数，路径只走环境变量，避免两条设置路径打架。
- Windows 用 bash 时不再是 verbatim 参数（那是 `cmd` 需要的），改由 Node 正常转义 `-c` 后面的整条命令。
- 解码顺序：先严格 UTF-8；失败则丢掉开头被截断的半个字符再试一次（tail 读会从字符中间开始）；仍失败且在 Windows 上，用 `gb18030` 解码。POSIX 上不启用 GBK 回退 —— 那里非法 UTF-8 更可能是二进制，硬解成 GBK 会把日志变成另一种乱码。
- `bg_logs`、面板、完成通知都经过同一个读取函数，所以三处看到的文字一致；面板里 `output` 字段不因为编码而不一致。
- 输出文件仍是原始字节，`kill reason`、字节计数、输出上限都以字节为准，编码只影响展示层。
