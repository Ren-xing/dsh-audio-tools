# 上架社区插件市场（awesome-dsh-plugin）

DSH 的「插件市场 / Discover」读的是社区精选列表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
**一个插件 = 一个 YAML 文件**，PR 合并后站点与市场通常一天内自动收录。

`awesome-dsh-plugin.yml` 就是本插件的投稿文件，`scripts/set-release-owner.mjs`
会把其中的 `OWNER` 换成你的 GitHub 用户名。

## 收录规则（2026-10 实测）

| 规则 | 本仓库 |
| --- | --- |
| `package.json` 里有 `dsh.bundle` 且能安装 | ✅ `dsh.bundle.patch` + `cordis.patch.yml` |
| 仓库存在、未归档、非 DSH 本身 | ✅ |
| 仓库创建满 **1 天**（CI 自动检查） | ⏳ 今天新建的话明天再提 PR |
| 仓库加 `dsh-plugin` topic | 建仓库后手动加 |
| 描述只说功能、必须与代码相符 | ✅ 三个工具如实描述 |
| 分类选贴合实际用途的 | `voice`（语音/音频方向） |
| 一个 PR 最多 3 条 | 本插件 1 条 |

完整规则见 `contributing.md` 与 `scripts/check-submission.mjs`（`MIN_AGE_DAYS = 1`）。

## 操作步骤

```powershell
# 1. 建 GitHub 仓库并推送（仓库名 dsh-audio-tools）
git remote add origin https://github.com/<你的用户名>/dsh-audio-tools.git
git push -u origin main
# 然后在仓库 Settings 里加 topic: dsh-plugin

# 2. 发布 npm 包（可选，但推荐；市场安装会优先用 npm）
npm login
npm publish --access public

# 3. 满 1 天后：fork awesome-dsh-plugin，加一个文件
#    data/plugins/<你的用户名>__dsh-audio-tools.yml
#    内容 = market/awesome-dsh-plugin.yml（OWNER 已替换）
#    然后提 PR，标题：Add dsh-audio-tools
```

> 市场收录**不强制** npm 发布：只是没有 npm 包时，市场只能给出 GitHub 安装方式。
> 本地也可以用 `dsh plugin --profile desktop add "<tgz 或 git URL>"` 先自测。
