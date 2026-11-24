---
type: source
title: npm 发布改用 trusted publishing（OIDC），放弃绕 2FA 的长期 token
status: insight
category: ci
created: 2026-11-24
updated: 2026-11-24
slug: npm-trusted-publishing-oidc-not-token
---

# npm 发布改用 trusted publishing（OIDC），放弃绕 2FA 的长期 token

## 现象

2026-11-24 发 pi-pretty-task v1.0.8，`publish.yml` 用仓库 secret `NPM_TOKEN` 连续失败两次：

```
npm error code E404 - PUT https://registry.npmjs.org/pi-pretty-task - Not found
npm error code E403 - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages
```

404 是 token 对包无权限（或已失效），403 是 token 少了「绕过 2FA」。再申请一枚"能绕 2FA"的 token 没有意义：npm 已在收口——账户类变更 2026-08 起、直接 `npm publish` 2027-01 起都不再接受这类 token。

## 正解：trusted publishing（OIDC）

npm 文档要求：npm CLI ≥ 11.5.1、Node ≥ 22.14.0、GitHub 托管 runner。

工作流侧（三步就够）：

```yaml
permissions:
  id-token: write   # OIDC
  contents: read
steps:
  - uses: actions/setup-node@v4
    with: { node-version: 24, registry-url: https://registry.npmjs.org }
  - run: npm publish     # 不要 NODE_AUTH_TOKEN
```

CLI 在 OIDC 环境里自动换短期 token 并自带 provenance；设了 token 反而优先用 token。

npm 侧要在包设置的 Trusted Publisher 里填：org/用户、repo、workflow **文件名**（`publish.yml`，只写文件名）。坑：2026-09-03 之后新建的配置**默认只允许 `npm stage publish`**，想直接 `npm publish` 必须显式勾上 Allowed actions 里的直接发布，否则照样 403。

## 教训

- 发布失败时先读报错的 code：E404 与 E403 是两件事，换 token 只会把 404 变成 403。
- 长期 publish token 现在是最差的选择：既会泄漏又要绕 2FA，而这条路正在被关掉。新包一律 OIDC + provenance。
- Node 22 默认 npm 10.x，不满足 11.5.1；要么升 Node 24，要么在 workflow 里升 npm 并加版本闸。


*Category: ci*

---
*Captured: 2026-11-24*

## Related

_Add links to related pages._
