# 发布流程

README 只留一句指向这里。本文记录 `pi-pretty-task` 发到 npm 的完整动作和踩过的坑。

## 触发方式

版本由 [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) 发布：在 GitHub 上创建并发布一个 Release，工作流就跑。

## 步骤

- 升版本但不打本地 tag：`npm version <x.y.z> --no-git-tag-version`。
- 提交 `package.json` 和 `package-lock.json`，推到 `main`。
- 在 GitHub 建 Release，tag 用 `v<x.y.z>`，然后发布。

命令行建 Release 用 `--target main`，不要传 commit sha：`gh release create --target <sha>` 会被 GitHub 拒成 `422 tag_name is not a valid tag / target_commitish is invalid`，而 `main` 是合法的 target，tag 由这次操作新建并指向它。

```bash
gh release create v<x.y.z> --title "v<x.y.z>" --notes-file .tmp/release-notes.md --target main
```

发布日志用 `gh run list --limit 3` 找到 `publish` 那条，再 `gh run view <id>`；成功之后用 `npm view pi-pretty-task version` 和 `npm view pi-pretty-task dist-tags` 确认 registry 真的换到新版本，不靠工作流的绿色灯。
- 工作流会做四件事：核对 tag 与 `package.json` 一致；确认 tarball 里带 `src/`、`skills/` 和 `dist/`；执行 `npm publish`；轮询 registry 直到该版本真的可见。
- 预发布版本（带 `-next.0` 这类后缀）发到 `next` dist-tag，不占 `latest`。

## 认证：OIDC，不存 token

发布不再用仓库 secret，改走 npm 的 trusted publishing（[ADR-0023](adr/0023-publish-through-oidc-not-a-token.md)）：GitHub 侧要 `id-token: write` 与 Node ≥ 24（自带 npm ≥ 11.5.1），npm 侧按 `repo: mystery4f/pi-pretty-task` + `workflow: publish.yml` 配 trusted publisher，并勾选允许直接 `publish`——2026-09-03 之后新建的 trusted publisher 默认只给 staged，少了这一步 `npm publish` 会被拒。工作流里的 `NODE_AUTH_TOKEN` 和仓库 secret `NPM_TOKEN` 都已删除。

失败时先看 `gh run view <id> --log-failed`：出现 `403 … bypass 2fa` 说明还在用 token 那条老路；出现误导性的 `E404 Not Found` 多半是 trusted publisher 的 repo/workflow 名对不上。

## 已知坑

- 历史：改用 OIDC 之前，token 必须 **Read and write** 且开 **Bypass 2FA**，首次发布新包名还要 **All packages**；这几个坑随 token 一起作废，留在这里只为看懂老日志里的 `403 bypass 2fa`。
- 全新的包名可能被一个 `0.0.0-stage` 占位版本挡住几分钟，发布任务里的 registry 轮询就是用来判断真实版本何时顶替占位的。
- 发布完成后，pi.dev 画廊（<https://pi.dev/packages>）需要自己的索引周期才会收进新包。搜不到时先确认包里带 `pi-package` keyword，再等一轮索引；正常几十秒到几分钟。