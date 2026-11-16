---
type: synthesis
title: "pi-pretty-task 1.0.0 发布支持落地记录"
slug: release-1-0-0-publish-support
category: release
created: 2026-11-16
updated: 2026-11-16
status: done
---

# pi-pretty-task 1.0.0 发布支持落地记录

## 本次交付

- 新增 [`.github/workflows/publish.yml`](../../../.github/workflows/publish.yml)：GitHub Release `published` 事件触发，`actions/setup-node@v4` 配 `registry-url: https://registry.npmjs.org`，执行 `npm ci` / `npm run check` / `npm run lint` / `npm run build`，并校验 tarball 必须带 `src/index.ts`、`skills/pretty-task-templates/SKILL.md`、`dist/index.js`；校验 Release tag 与 `package.json` 版本一致，缺 `NPM_TOKEN` 时提前报错；预发布走 `--tag next`，正式发布走 `npm publish`。
- `package.json` 版本升到 `1.0.0`（同步 `package-lock.json`），`files` 从 `["dist"]` 改为 `["dist", "src", "skills"]`，补 `repository`/`homepage`/`bugs`、`publishConfig`（public + 官方 registry）与 `prepack: npm run build`。
- `README.md` 补 `## Install`（`pi install npm:pi-pretty-task`）、`## Releasing`，并写明首次发布所需 npm granular token 的权限与收紧方式。
- 1.0.0 tarball 已打包到 [`.artifacts/pi-pretty-task-1.0.0.tgz`](../../../.artifacts/pi-pretty-task-1.0.0.tgz)（被 `.gitignore` 忽略，未进 git）：132 个文件、289041 字节。

## 关键决策与原因

- **触发方式选 GitHub Release 发布事件 + `NPM_TOKEN` Secret**（用户选定）：发布动作人工可控，能写 release notes；OIDC trusted publishing 需要 npm 端 trusted-publisher 配置，留作后续迁移。
- **修复了一个会让 npm 包根本不可用的打包缺陷**：`package.json` 的 `pi.extensions` 指向 `./src/index.ts`、`pi.skills` 指向 `./skills`，但旧 `files` 只发布 `dist/`，tarball 里没有入口和 skill。发布流程里的 tarball 校验就是防它回归。
- **`prepack` 自动构建 `dist/`**：`dist/` 按仓库约定永不提交，`npm pack` / `npm publish` 时现生成。
- **首次发布 token 必须是 `All packages` / `Read and write` / `Bypass 2FA`**：`pi-pretty-task` 尚未存在于 npm，`Only select packages` 无法选中它，过窄的 token 会报误导性的 `E404 Not Found`。1.0.0 上线后应换成只限定该包的 token，或迁移到 npm trusted publishing (OIDC) 并删掉 token。
- **发布 job 不重跑完整 `npm test`**：`.github/workflows/verify.yml` 已对每个 push/PR 跑全套；且该 CI 基线本来就有与本次改动无关的红灯（Linux 平台/时序断言、Windows 8.3 短路径），发布的增量门禁是 check/lint/build + tarball 内容校验。

## 验证结果

- `npx yaml-lint .github/workflows/publish.yml`：通过。
- `npm run check`：exit 0；`npm run lint`：exit 0（74 files，无改动）。
- `npm pack --dry-run --json --ignore-scripts`：`pi-pretty-task@1.0.0`，132 files，289041 bytes；工作流里的 `jq` 表达式逐项验证 `src/index.ts`、`skills/pretty-task-templates/SKILL.md`、`dist/index.js` 均在包内。
- 删掉 `dist/` 后直接 `npm pack`（不跳过 scripts）：`prepack` 成功重建 `dist/`，包内容仍是 132 files。
- 真实 tarball `tar -tzf`：含 `package/dist/index.d.ts`、`package/dist/index.js`、`package/LICENSE`、`package/package.json`、`package/README.md`、`package/skills/pretty-task-templates/SKILL.md`、`package/src/index.ts`。
- 提交：`0f14754 feat(release): publish to npm from GitHub Release and cut 1.0.0`，作者 `mystery4f <40482524+mystery4f@users.noreply.github.com>`（按 `AGENTS.md` 指定身份覆盖本机 `dongcheng.xie` 配置）。

## 待用户完成的发布动作

1. 在 npmjs.com → Access Tokens → Granular Access Token 创建 token；设置 `All packages` / `Read and write` / 勾选 `Bypass 2FA`；复制后添加到仓库 Secret `NPM_TOKEN`（`gh secret set NPM_TOKEN --repo mystery4f/pi-pretty-task`）。
2. `git push origin main` 推送 `0f14754`；确认 `verify` job 的既有红灯情况（与发布代码无关）。
3. 创建 GitHub Release，tag 用 `v1.0.0`，点 Publish；`publish` 工作流会自动 `npm publish`。
4. 发布成功后把 token 收紧到 `pi-pretty-task` 单包，或迁移 OIDC 后删除 token。
5. 本机未登录 npm（`npm whoami` 报 `ENEEDAUTH`），`gh secret list` 为空，因此端到端自动发布未在本会话执行。

## 关联

- [[pi-pretty-task-文档索引]]
- [[pi-git-install-omits-dev-deps-so-ship-ts-entry]]
