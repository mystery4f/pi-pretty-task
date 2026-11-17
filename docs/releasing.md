# 发布流程

README 只留一句指向这里。本文记录 `pi-pretty-task` 发到 npm 的完整动作和踩过的坑。

## 触发方式

版本由 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) 发布：在 GitHub 上创建并发布一个 Release，工作流就跑。

## 步骤

- 升版本但不打本地 tag：`npm version <x.y.z> --no-git-tag-version`。
- 提交 `package.json` 和 `package-lock.json`，推到 `main`。
- 在 GitHub 建 Release，tag 用 `v<x.y.z>`，然后发布。
- 工作流会做四件事：核对 tag 与 `package.json` 一致；确认 tarball 里带 `src/`、`skills/` 和 `dist/`；执行 `npm publish`；轮询 registry 直到该版本真的可见。
- 预发布版本（带 `-next.0` 这类后缀）发到 `next` dist-tag，不占 `latest`。

## NPM_TOKEN 要求

发布步骤用仓库 secret `NPM_TOKEN` 认证，设置命令：

```bash
gh secret set NPM_TOKEN --repo mystery4f/pi-pretty-task
```

token 必须是 **Read and write** 且开启 **Bypass 2FA**。不开 bypass，CI 发布会被 npm 拒绝：

```text
403 … Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

## 已知坑

- **首次**发布一个新包名时，token 还需要 **All packages** 权限：包还不存在，选不到具体包。权限太窄会报一个误导性的 `E404 Not Found`。包存在之后应把 token 收窄到这一个包。
- 开了 Bypass 2FA 的 token 不能 unpublish，而且 npm 正在弃用它。迁移到 [trusted publishing](https://docs.npmjs.com/trusted-publishers/) 可以完全不存 secret。
- 全新的包名可能被一个 `0.0.0-stage` 占位版本挡住几分钟，发布任务里的 registry 轮询就是用来判断真实版本何时顶替占位的。
- 发布完成后，pi.dev 画廊（<https://pi.dev/packages>）需要自己的索引周期才会收进新包。搜不到时先确认包里带 `pi-package` keyword，再等一轮索引；正常几十秒到几分钟。