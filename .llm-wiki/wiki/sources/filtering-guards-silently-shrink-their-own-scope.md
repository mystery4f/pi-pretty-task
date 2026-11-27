---
type: source
title: 靠正则筛项的守卫会悄悄缩小自己的检查范围
status: insight
category: architecture
created: 2026-11-27
updated: 2026-11-27
slug: filtering-guards-silently-shrink-their-own-scope
---

# 靠正则筛项的守卫会悄悄缩小自己的检查范围

`test/unit/readme-keys.test.ts` 的旧版本用一个正则判断"这一段是不是键"：`/^[^\w\s]{1,3}$/`。它把 `k`、`a`、`R`、`c`、`x` 这些**单字符键全过滤掉了**，于是那条断言实际只核对了 4 个键（`↑/↓`、`Enter`、`alt+q` 之类），`←` 才能安然混在 README 的 "List keys" 一行里——那是详情页才有效的键，列表分派里根本不做事。

两类守卫缺陷，症状一样（一直是绿的），原因不同：

- **过滤式守卫**：先按正则筛掉"看起来不是键"的 token，再断言剩下的都在允许集合里。筛错一点，断言范围就缩一点，而且缩得无声无息。
- **无覆盖下限**：只断言"不包含非法项"，不断言"至少核对了 N 项"。上面的守卫如果加一句 `expect(checked.size).toBeGreaterThan(6)`，问题当场暴露。

修法（已验证）：判断函数改成"单字符算键、单词排除"（`/[A-Za-z0-9]/` 算按下去了，`all`/`running` 这类单词是值）；断言改成按页取白名单（README 的 `List keys:` 行对 `LIST_KEYS[0]`、`Detail keys:` 行对 `PROCESS_KEYS[0]`），再加每页的键数量下限。

相关：[[sources/obs-2026-11-27-footer-handleinput]]

*Category: architecture*

---
*Captured: 2026-11-27*

## Related

_Add links to related pages._
