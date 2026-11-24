# 0023 — 发布走 OIDC，不留长期 token

## 状态

已接受（2026-11-24）

## 背景

`publish.yml` 一直用仓库 secret `NPM_TOKEN`（granular access token，publish 权限 + 绕过 2FA）发布。2026-11-24 发 v1.0.8 时这条链第一次断：

- 旧 token 返回 `npm error code E404 - PUT https://registry.npmjs.org/pi-pretty-task - Not found`；
- 换一枚新 granular token 后变成 `npm error code E403 - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages`。

npm 正在收掉"靠绕 2FA 的长期 token 直接发布"这条路：账户类变更自 2026-08 起、直接 `npm publish` 自 2027-01 起不再接受这类 token。npm 自己的 trusted publishing 文档同页写明：2026-09-03 之后新建的 trusted publisher 配置**默认只允许 `npm stage publish`**，要直接 `npm publish` 必须显式勾选。

也就是说：再申请一枚"能绕 2FA"的 token，是在为一个两个月后关掉的口子续命。

## 决策

**发布改用 npm 的 trusted publishing（OIDC），仓库不再持有任何能发包的长期凭据。**

- `publish.yml` 的 `permissions` 加 `id-token: write`；`contents: read` 保留。
- Publish 步去掉 `NODE_AUTH_TOKEN`。npm CLI 在 OIDC 环境里自动用它换短期 token，并自带 provenance。
- 删掉 `Check npm credentials` 一步，换成一枚版本闸：`npm --version` 必须 ≥ 11.5.1（trusted publishing 的下限）。Node 从 22 升到 24，因为 Node 22.14 自带的是 npm 10.x。
- 删掉仓库 secret `NPM_TOKEN`：不用的凭据留着就是泄漏面。
- npm 侧为包 `pi-pretty-task` 配 trusted publisher：GitHub Actions、组织/用户 `mystery4f`、仓库 `pi-pretty-task`、workflow 文件名 `publish.yml`，并勾选允许直接 `npm publish`（否则只剩 staged）。

## 代价

- 发布成功与否取决于 npm 侧那条配置与仓库名、workflow 文件名逐字相同：改仓库名或重命名 `publish.yml` 就要同步改 npm 侧，否则发布 403/404，报错不会指向这里。
- 权限从"任何持有 token 的人或机器"缩成"只有这条 workflow 的 OIDC 身份"，本地手工 `npm publish` 仍可用人工 2FA，但不再与 CI 共用一枚 token。
- 2027-01 之后若 npm 只认 staged publish，这条 workflow 要改成 `npm stage publish`，再由维护者在 npmjs.com 用 2FA 批准——发布多一步人工。`Confirm the version reached the registry` 一步已经能识别这种"accepted 但不可见"的等待状态。
- 依赖 runner 自带的 npm 版本：升 Node 大版本时这枚版本闸会先失败一次，而不是发布到一半报 403。

## 落地时踩到的两个坑

- `actions/setup-node` 的 `registry-url` 会往 `.npmrc` 写一行 `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`。没有 token 时这行是空的，请求带着一个空 token 出去，registry 直接 404，OIDC 根本轮不到——凭据是空的，不是"没有凭据"。所以本工作流不带 `registry-url`，npm 默认就是 registry.npmjs.org。
- npm 的 OIDC 交换失败从不抛错，只把上下文塞进 `~/.npm/_logs/*-debug-0.log`，对外只剩一句 `ENEEDAUTH`。工作流因此加了一步 `if: failure()`，把交换日志里的 `oidc|id.token|auth` 行打出来。这次靠它一次定位到 `POST /-/npm/v1/oidc/token/exchange/package/pi-pretty-task` 返回 `404 ... package not found`，含义是"该包名下没有匹配的 trusted publisher"，不是包不存在。

## 验证

2026-11-24 手动 dispatch `publish`（`45448944187`）绿灯，registry 侧 `pi-pretty-task` 的 `dist-tags.latest` 变成 `1.0.8`，且该版本带 provenance 证明（`dist.attestations.url` 指向 `/-/npm/v1/attestations/pi-pretty-task@1.0.8`）。整个过程没有任何 token。

## 相关

- `.github/workflows/publish.yml`：`permissions`、Node 版本、版本闸、Publish 与确认步。
- `docs/adr/0007-release-path.md`：最初的发布路径设计。
- npm trusted publishing 文档：<https://docs.npmjs.com/trusted-publishers/>
