# AI RSS Reader F for Obsidian

AI RSS Reader F 是一个面向论文与研究资讯的 Obsidian 桌面插件。它可以抓取 RSS / Atom 订阅，按照用户定义的研究方向进行关键词预筛和 AI 相关性判断，并把网页正文、BibTeX、PDF 和 AI 分析整理到同一个文献文件夹中。

📖 新用户请先阅读：[AI RSS Reader 图文使用教程](docs/使用教程.md)。

本项目由原 Python / PySide 版本独立迁移而来。插件界面、设置、数据和笔记输出均由 Obsidian 管理，运行时不需要 Python。

## 功能概览

### RSS 阅读器

- 并行抓取多个 RSS / Atom 源，每个源可启用、停用、编辑或删除
- 按文章链接去重，并记录已处理链接
- 搜索标题、摘要和来源，按五类文章状态和研究方向筛选
- 表格展示标题、期刊、研究方向、推荐说明、更新时间和预览图
- 表头列之间可拖拽调整每列宽度，宽度会自动保存并在下次打开阅读器时恢复
- 点击文献标题直接打开内置浏览器并进入采集流程，标题以外的数据单元格用于选中条目；打开时自动标记为已读
- 保持表格滚动位置，支持多选、全选、批量已读/未读、重新分析和保存笔记
- 批量标记已读/未读或保存笔记完成后会清除当前勾选，避免筛选后隐藏的条目被后续操作误处理
- 顶部五类分类：未读、感兴趣、归档、已隐藏、已过期；点击分类切换列表

### 精选文章与探索模式

- **精选文章**：保留研究方向 AI 筛选、表格、多选、重新分析、正文采集和笔记保存。此页不显示个性化推荐面板。旧文章按已有研究方向匹配记录识别为精选。
- **探索模式**：包含文献阅读、订阅管理、兴趣分析三个子页。RSS 返回的文章先完整保存，再进行精选筛选；未匹配及 AI 失败的文章仍保存在探索模式。探索的五个篮子排除精选文章。
- **五个篮子**：未读、感兴趣、归档、已隐藏、已过期。支持搜索、期刊筛选、分类、撤回最近一次分类、隐藏剩余未读、每次加载 100 条。
- **自适应布局与预览图**：内容使用整个工作区宽度；标题与期刊名称自动换行，列宽按比例分配，支持拖动调整。预览列默认更宽。鼠标悬停显示放大光标和“放大查看”提示，点击打开 Obsidian 原生“摘要图”弹窗；窄窗口下探索卡片上下排列。
- **操作图标**：刷新、撤回、隐藏、翻译、排序、关键词推荐和 LLM 复核沿用 Academic RSS Reader 对应的 Obsidian/Lucide 图标，保留中文文字；“重置列宽”可以恢复均衡的表格比例。
- **预览图提取**：支持 Media RSS、RSS/Atom 图片附件和摘要 HTML，过滤装饰图与跟踪图，仅显示 HTTP(S) 图片。图片懒加载，失败显示占位文字。更新订阅会补充仍在 RSS 中的旧文章图片；不额外抓取论文正文来查图。

### 探索模式中的个性化推荐

- 以精选文章、感兴趣和归档为正样本，隐藏与过期为负样本。精选文章自动作为感兴趣训练样本，不改变其原有阅读分类；每类至少 2 篇才训练。
- 移植 Academic RSS Reader 的分词、TF-IDF、类别平衡逻辑回归、验证集划分和自动阈值校准。训练在本地完成，支持取消；订阅更新后，样本足够时自动更新推荐，训练数据未变则复用模型。
- 展示高相关、待判断、低相关、未评分数量、验证准确率、阈值及正负关键词证据。样本不足以划分验证集时明确标注未验证。评分不是准确率。
- 可以查看推荐关键词词表、禁用或重新启用词条，并设置高低阈值；留空自动校准。文章、分类或推荐设置变化后旧评分失效，不再用于批量隐藏。
- “使用 LLM 复核待判断文章”仅在点击后调用当前配置的 AI 服务，结合研究兴趣复核待判断的探索文章。失败可重试，不对精选文章重复复核。正常订阅更新不自动调用此复核。
- “翻译标题”调用当前 AI 服务翻译当前显示的文章为简体中文，缓存译文并允许切回原文。
- 支持按标题、更新时间、期刊和相关度排序；相关度按高 → 待判断 → 未评分 → 低排列。同档按分数、日期和 ID 稳定排序。
- 兴趣分析展示阅读分类、正向关键词和感兴趣来源分布。数据沿用 F 插件的本地保存机制，没有引入上游 SQLite 数据库。

### RSS 源文件导出与导入

每次点击“检测所有 RSS 源”，完成检测后自动将所有源（包括停用及检测失败的源）的名称、RSS 链接、启用状态和检测结果写入 **F 插件安装文件夹根目录**的 `rss-sources.json`。通常路径为 `库目录/.obsidian/plugins/ai-rss-reader-f/rss-sources.json`；界面提示会显示实际路径。

设置中的检测区域和探索模式的订阅管理都提供“从本地导入 RSS 链接”。它读取同一文件，每项成为独立订阅源；重复 URL 合并并保留已有订阅 ID。导入会先验证全部内容，格式错误不会部分修改订阅。文件不包含 AI 服务设置，可手动编辑 `feeds` 数组后再次导入：

```json
{"version":1,"feeds":[{"name":"示例期刊","url":"https://example.org/rss","enabled":true}]}
```

实现来源：[Academic_RSS_Reader-Obsidian](https://github.com/ApoclyReol/Academic_RSS_Reader-Obsidian)，移植版本及 MIT 许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

设计与校验使用 Obsidian 官方 `ItemView`、`Modal`、`requestUrl`、`Plugin.loadData/saveData`，并以项目安装的官方 `obsidian` TypeScript 定义检查 API：[官方 API 源码](https://github.com/obsidianmd/obsidian-api)。本地验证命令：

```powershell
node node_modules/typescript/bin/tsc -noEmit -skipLibCheck
node --test tests/*.cjs
node esbuild.config.mjs production
```

已安装并启用 [Obsidian 官方 CLI](https://help.obsidian.md/cli) 时，部署后可用 `obsidian vault="你的库名称" plugin:reload id=ai-rss-reader-f` 重载，再检查五类分类、图片放大和排序。部署前备份原有 `main.js`、`styles.css`、`manifest.json`，保留 `data.json`；升级首次加载会迁移文章状态，如需回滚数据请自行保留原状态文件备份。

### AI 研究方向筛选

- 创建多个中英文研究方向并独立启用或停用
- 可选关键词预筛，减少模型调用量
- 一次请求判断文章与多个方向的相关性，并保存中文推荐理由
- 可重新分析选中文章，并选择是否保留未匹配文章
- 可分别设置隐藏与未读条目的保留天数（默认 30 天和 90 天，`0` 表示不自动过期）；感兴趣和归档永久保留

支持 ChatGPT Plus/Pro (Codex)、OpenAI API、DeepSeek、Google Gemini、Ollama 和自定义 OpenAI 兼容接口。每个供应商分别保存自己的 API Key、模型、API 地址和 Codex 命令，来回切换时会恢复上次配置。

### ChatGPT Plus/Pro (Codex) 登录

插件通过 OpenAI 官方的 [Codex app-server](https://learn.chatgpt.com/docs/app-server) 接入 ChatGPT 订阅，不读取、复制或保存 OAuth 令牌。需要先在电脑上安装可用的 Codex CLI，然后在“设置 → AI RSS Reader F → AI 模型”中：

1. 将服务商设为 `ChatGPT Plus/Pro (Codex)`。
2. 保持“Codex 命令”为 `codex`；插件会检查 PATH，并在 Windows 上自动查找 Codex Desktop。仍找不到时填写 `codex.exe` 的完整路径。
3. 点击“登录 ChatGPT”，在系统浏览器中完成授权。
4. 在模型下拉框中选择当前 ChatGPT 账户可用的模型，或选择“跟随 Codex 默认模型”。列表由 app-server 的 `model/list` 动态读取，与 Codex 桌面版使用同一模型目录。

登录状态和令牌刷新由本机 Codex 管理，切换供应商不会退出登录或清除令牌。插件只保存 Codex 命令与可选模型名；每批分析使用临时线程，并启用 Codex 内置只读沙箱和 `approvalPolicy: never`，Codex 分析结果通过严格 JSON Schema 校验，完成后关闭 app-server 进程。“退出本机 Codex”会清除共享的本机 Codex 登录，可能同时影响 Codex CLI 等客户端。

ChatGPT 订阅访问与 OpenAI API Key 是两种独立认证方式：选择 Codex 服务商时使用订阅配额；选择 OpenAI 服务商并填写 API Key 时按 OpenAI Platform API 用量单独计费。使用范围、可用模型和限额以当前 ChatGPT 方案为准。

## 文献保存流程

阅读器顶部的“链接 / DOI”按钮（或命令面板中的“通过链接 / DOI 查看文献详情”）支持输入完整 HTTP(S) 文献链接、裸 DOI、`doi:` 前缀或 `https://doi.org/…` 链接。可一次粘贴多条，每行一条；空行和重复链接会忽略。导入弹窗和 RSS 列表的批量“保存笔记”都会先显示本次保存根目录，可填写 Obsidian 库内的相对路径；插件会记住最近一次确认的路径并在下次打开这两类弹窗时回填，但不会改写设置页中的全局默认输出文件夹。单条导入与点击文章标题共用同一采集流程，继续使用现有浏览器、机构代理、下载和笔记设置；多条导入则复用阅读器的批量保存队列，按输入顺序自动抓取，失败后继续下一条并在结束时汇总结果。已有相同链接的 RSS 文章会复用其信息；其他文献直接保存到所选目录的“手动导入”子目录，不加入 RSS 筛选列表。

点击文献标题、提交链接 / DOI 或批量保存后，插件会：

1. 读取文章网页 HTML。点击 RSS 文献标题会跳过详情弹窗，直接打开对应论文的内置浏览器标签，已有标签则复用；顶部“开始抓取”栏显示设置页中的默认输出文件夹，并允许为本次保存改成其他库内相对路径。单篇保存等待用户确认正文加载完成后点击“开始抓取”，确认的路径也会成为导入和批量保存弹窗下次回填的最近路径，但不会修改全局默认值。如果插件判断当前地址与目标文献不匹配，但用户确认页面确实正确，可点击随后出现的“确认正确，继续抓取”覆盖本次地址校验。批量保存（包括选中后点击“保存笔记”和一次输入多条链接 / DOI）按选中顺序在后台逐篇打开页面、按设置的检查间隔自动等待正文可抓取并开始读取，AI RSS Reader 面板保持显示，文献文件保存成功后自动关闭对应网页，再继续下一篇。批量过程中若遇到机构登录页或页面在 60 秒内始终未就绪，会记录失败并继续后续文献，结束时汇总成功与失败数量，避免保存错误页面。
2. 使用 [Defuddle](https://github.com/kepano/defuddle) 提取主要内容并转换为 Markdown。
3. 从 `citation_*`、Dublin Core、页面链接和 DOI 提取作者、年份、期刊、标题等元数据。
4. 优先从网页或 DOI 获取 BibTeX；失败时根据元数据生成 `.bib`。
5. 查找页面声明的 PDF、正文 PDF 链接或 arXiv PDF 地址并尝试下载。
6. 查找并下载补充材料和同行评审文件，支持多个附件及一层附件列表页。
7. 在本次所选根目录下按“RSS 名称 / 文献文件夹”创建目录，将 Markdown、BibTeX、PDF 和附件保存到同一目录。单篇保存成功后默认打开生成的 Markdown；可在设置中关闭，批量保存始终不会逐篇打开。

```text
AI RSS Reader/
└── RSS 名称/
    └── Lovelace - 2026 - Example paper title/
        ├── Lovelace2026Example.md
        ├── Lovelace2026Example.bib
        └── Lovelace2026Example.pdf
```

某项无法获取时，其他文件仍会保存，原因会写入 Markdown 的“采集提示”。找不到对应论文标签或检测到机构登录、图书馆提示页时，只保留 RSS 摘要和提示，不使用该页面的标题及正文。PDF 下载不会绕过访问控制，取决于公开权限或用户已有的机构授权。

批量保存 RSS 文章或批量导入链接／DOI 时，如果某个条目最终没有创建 Markdown，插件会把抓取时间、标题、原始链接、来源和失败原因追加到 `AI RSS Reader/faild.md`。已经生成或原本已有 Markdown 的条目不会写入该失败记录；正文、PDF 或附件等部分失败仍只记录在对应笔记的“采集提示”中。

RSS 名称取自文章的订阅源名称，不合法的路径字符会替换为连字符；空名称使用“未命名 RSS”。此结构适用于新保存的文献，已有文件不会自动迁移。自定义输出目录仍然有效。

## 文件夹命名模板

| 变量 | 内容 |
| --- | --- |
| `{author}` | 第一作者姓氏 |
| `{authors}` | 全部作者 |
| `{year}` | 出版年份 |
| `{journal}` | 期刊或站点 |
| `{title}` | 文献标题 |
| `{citekey}` | 引用键 |
| `{doi}` | DOI |

默认模板是 `{author} - {year} - {title}`。Windows 禁止的文件名字符会自动替换，过长目录名会被截断。

## Markdown 与 YAML Properties 模板

设置中的“Markdown 与 YAML 模板”可以编辑笔记文件名、Markdown 正文和 YAML Properties JSON，也可以导入 Obsidian Web Clipper 风格模板。导入时读取 `noteNameFormat`、`noteContentFormat`、`properties` 和 `path`；忽略 `triggers`、`behavior` 等剪藏器专用字段。

### 模板变量

| 变量 | 内容 |
| --- | --- |
| `{{title}}` | 文献标题 |
| `{{url}}` | 原文链接 |
| `{{source}}` | RSS 来源 |
| `{{author}}` / `{{authors}}` | 作者字符串 / 作者列表 |
| `{{published}}` / `{{date}}` | 出版日期 / 保存日期 |
| `{{description}}` | RSS 摘要 |
| `{{journal}}` / `{{year}}` | 期刊 / 年份 |
| `{{doi}}` / `{{doiLink}}` | DOI / Markdown DOI 链接 |
| `{{citekey}}` | 引用键 |
| `{{profiles}}` | 匹配的研究方向 |
| `{{content}}` | Defuddle 正文 |
| `{{aiAnalysis}}` | AI 分析结果 |
| `{{bibfile}}` / `{{pdffile}}` | BibTeX / PDF 文件名 |
| `{{attachmentfiles}}` / `{{attachmentsSection}}` | 附件文件名列表 / 带链接的附件章节（`{{filesSection}}` 也包含附件） |
| `{{filesSection}}` | 文件链接章节 |
| `{{warningsSection}}` | 采集提示 Callout |

支持 `split`、`wikilink`、`join`、`trim`、`lower`、`upper` 过滤器。例如：

```text
{{author|split:", "|wikilink|join}}
```

YAML Property 支持 `text`、`multitext`、`date`、`number` 和 `checkbox` 类型：

```json
[
  { "name": "title", "value": "{{title}}", "type": "text" },
  { "name": "authors", "value": "{{authors}}", "type": "multitext" },
  { "name": "published", "value": "{{published}}", "type": "date" },
  { "name": "tags", "value": "ai-rss-reader", "type": "multitext" }
]
```

这些元信息会写入 Markdown 顶部的 YAML frontmatter，并显示为 Obsidian Properties。

## EZProxy 机构访问

保存或更新文献时，只要需要提取正文或下载 PDF／附件，插件都会打开 Obsidian 网页浏览器，并在标签顶部显示抓取状态和“取消”。单篇保存仍等待手动确认：可以先完成登录、等待正文和公式加载，再点击“开始抓取”。若地址校验失败，状态栏会显示目标与当前地址，并提供“确认正确，继续抓取”按钮供用户覆盖本次校验；覆盖后仍会检查登录提示页、正文就绪状态和抓取期间的页面跳转。批量保存不会使用人工覆盖，仍会严格匹配地址，并每隔短时间自动检查当前页面；正文校验通过后自动读取，保存成功后关闭网页并继续下一篇。单篇和批量都不会把检测到的机构登录或图书馆提示页作为论文保存。APS 页面若全文尚未就绪，单篇允许稍后再次点击，批量会自动重试。通过 DOI 打开 APS、Nature 或 Science 文献时，插件会按 DOI 识别出版商落地页及其 EZProxy 地址，不会因正常跳转误报地址不匹配；未识别的出版商仍使用严格地址匹配。取消或关闭论文标签会结束对应文献的等待，卸载插件会取消全部未完成任务。

支持以下地址模板，`$@` 会直接替换为原始文献地址，不进行 URL 编码：

```text
https://sutd.idm.oclc.org/login?url=$@
```

先在“设置 → 核心插件”中启用“网页浏览器（Web viewer）”。点击设置中的“登录”后，插件会关闭设置页并打开 Obsidian 内置网页浏览器标签。完成机构登录、看到目标文献后，点击标签顶部的“完成登录”，插件记录代理会话。保存文献时也可以直接在打开的代理页面完成登录，然后点击“开始抓取”。点击“取消”或关闭标签会取消本次操作。

支持直接填写机构代理主机（如 `https://sutd.idm.oclc.org`），插件会将文献域名中的点替换为连字符，并追加机构代理域名，例如 `https://www.nature.com/articles/example` 转换为 `https://www-nature-com.sutd.idm.oclc.org/articles/example`。路径、查询参数和锚点会保留；已代理的地址不会重复转换。填写显式 `/login?url=$@` 模板则继续使用登录入口方式。保存文献时会读取网页浏览器中的最新代理 Cookie。“清除会话”只删除当前代理域及其子域的 Cookie 和插件保存值，不清除其他网站的会话；学校统一身份认证站点的登录可能仍然有效。

登录需要支持 Web viewer 的 Obsidian 桌面版（建议 1.8.3 或更新版本）。网页浏览器与会话接入使用 Obsidian 内部接口，若不可用会提示升级或启用核心插件。

## MinerU PDF 解析

MinerU 转换是独立于 RSS 文献抓取的功能。打开仓库中的 PDF 后，可从标签右上角菜单选择 **to MinerU markdown**；在左侧文件列表中右击 PDF 也有相同入口。右击文件夹会递归批量处理其中的 PDF，多选 PDF／文件夹后可从右键菜单批量处理；命令面板还提供“to MinerU markdown：解析当前 PDF”。批量任务按顺序执行，单个文件失败不会中断后续文件。

也可以通过 Obsidian CLI 调用插件流程。由于 Obsidian 的 `command` 子命令本身只接受命令 ID，不接受插件自定义参数，因此带路径或 DOI／URL 参数的入口使用 `eval` 调用插件公开的方法（Obsidian 必须已启动，插件必须启用）：

```powershell
# 一个或多个库内相对路径；路径包含空格时在 JavaScript 字符串中保留引号
$cliCode = @'
(async () => await app.plugins.getPlugin("ai-rss-reader-f").processPdfsFromCli(
  "Papers/one.pdf",
  "Papers/two.pdf"
))()
'@
obsidian vault="Zhefeng_Lou" eval code="$cliCode"

# 一个或多个 DOI／URL；每个参数一个文献，仍复用现有批量抓取、代理、浏览器和保存流程
$cliCode = @'
(async () => await app.plugins.getPlugin("ai-rss-reader-f").importLiteratureFromCli(
  "10.1038/nature12373",
  "https://arxiv.org/abs/1706.03762"
))()
'@
obsidian vault="Zhefeng_Lou" eval code="$cliCode"
```

`processPdfsFromCli` 使用仓库根目录下的精确相对路径，只接受 PDF；`importLiteratureFromCli` 接受裸 DOI、`doi:` 前缀或完整 HTTP(S) URL。两者都会显示插件原有的进度和失败提示，并使用原来的批量队列，不会另建一套抓取或 MinerU 逻辑。

结果保存在每个原 PDF 所在目录下的 `Miner_U/` 子文件夹。Markdown 统一命名为 `<PDF 名称>_MinerU.md`；图片按 Markdown 中首次出现的顺序转换并保存到 `Miner_U/Figures/`，命名为 `<PDF 名称>_MinerU_1.jpg`、`_2.jpg`……，Markdown 内的图片链接会同步更新。内容列表、布局和模型推理结果分别命名为 `_content_list.json`、`_layout.json` 和 `_model.json`；重复转换会更新同名结果。

保存 Markdown 前会进行 Obsidian 脚注后处理：正文中的单编号引用 `[n]` 转换为 `[^n]`，范围引用 `[1–3]` 展开为 `[^1],[^2],[^3]`，列表引用 `[4, 5]` 展开为 `[^4],[^5]`；范围与列表也可以混用。`## References`／`## Bibliography`／`## 参考文献`／`## 参考资料` 标题之后以 `[n]` 开头的参考文献条目转换为 `[^n]:`。已经是脚注格式的内容不会重复转换，图片语法中的数字替代文本也不会被误改。

“设置 → AI RSS Reader F → MinerU PDF 解析”可配置 API Token、标准 API 模型、OCR 语言、强制 OCR、表格／公式识别，以及是否保存 Markdown、内容列表 JSON、布局 JSON、模型推理 JSON、图片和其他解析文件：

- 配置 Token：使用 MinerU 标准 API 上传本地 PDF，下载并解压完整结果 ZIP。默认使用 VLM；官方限制为单文件不超过 200 MB、600 页。
- Token 留空：自动使用免登录轻量 Agent API。该接口按 IP 限流，单文件不超过 10 MB、20 页，并且只返回 Markdown；此模式下必须启用“保存 Markdown”。
- PDF 会上传到 MinerU 官方服务。需要完全本地处理的敏感文档请勿使用此功能。

> [!warning]
> API Key、MinerU Token 和 EZProxy Cookie 保存在 `<Vault>/.obsidian/plugins/ai-rss-reader-f/data.json`。Codex OAuth 令牌不保存在插件数据中，由本机 Codex 管理。请勿公开、提交或分享该文件。

## Theory Paper Audio Tutor

Audio Tutor 直接处理主论文及其 PDF 补充材料的 MinerU 完整解析结果，用于建立理论论文的“粗读 → 公式精读 → 推导练习 → 理解与复习”工作流。它不使用 RSS 摘要或 Defuddle 网文作为学习材料来源。

在原始 PDF 或对应的 `<PDF 名称>_MinerU.md` 上打开右键菜单，悬停 `Audio Tutor` 即可展开以下操作：

- 生成全部学习材料
- 生成无公式的教授式粗读讲稿
- 生成公式详解 Note
- 打开独立的推导练习界面
- 生成理解检查 Note
- 生成复习 Note

命令面板也提供对应的 `Audio Tutor：…` 命令。

### MinerU 完整数据要求

开始生成前，插件会检查以下内容：

- `Miner_U/<PDF 名称>_MinerU.md` 存在且非空
- `_content_list.json` 和 `_layout.json` 存在且是有效 JSON
- Markdown 引用的每张本地图片都存在
- 原始 PDF 可以找到

插件还会自动查找与主 PDF 位于同一目录、名称符合 `<主 PDF 名称>-supplementary-<序号>.pdf` 的补充材料。这与文献采集功能保存补充材料时使用的命名规则一致。每份补充材料都要通过同样的 Markdown、内容列表、布局和图片完整性检查；缺失时会自动调用 MinerU 解析，再将主文和全部补充材料一并交给 Audio Tutor。非 PDF 补充材料不会送入 MinerU 或学习材料生成。

如果任一必要产物缺失，插件会调用现有 MinerU 流程重新解析，并在本次任务中强制启用公式识别以及 Markdown、内容列表、布局和图片保存。这些临时要求不会修改设置页中的全局 MinerU 保存开关。

MinerU 免登录轻量 API 只能返回 Markdown，无法满足 Audio Tutor 对图片和布局数据的要求。因此数据不完整时必须先配置 MinerU 标准 API Token；否则任务会停止并显示缺失项，不会静默降级。

学习材料保存在对应 MinerU 目录下：

```text
Miner_U/
├── Paper_MinerU.md
├── Paper_MinerU_content_list.json
├── Paper_MinerU_layout.json
├── Paper-supplementary-1_MinerU.md
├── Paper-supplementary-1_MinerU_content_list.json
├── Paper-supplementary-1_MinerU_layout.json
├── Figures/
└── Paper_MinerU_Tutor/
    ├── tutor-manifest.json
    ├── Paper_Rough-Reading.md
    ├── Paper_Formula-Guide.md
    ├── Paper_Understanding.md
    ├── Paper_Review.md
    └── derivation-progress.json
```

`tutor-manifest.json` 记录源内容、提示词和输出的哈希。重新运行某项生成命令会更新该项 Note。

### 粗读讲稿与 Edge TTS

粗读讲稿只解释研究问题、体系、模型、近似、方法路线、主要结果、物理图像和局限，不包含公式或 LaTeX。

Edge TTS 可朗读库中的任意 Markdown。播放器只会在阅读模式的视图顶部显示，编辑模式下会自动隐藏；连续切换笔记时始终只保留当前笔记的一个播放器。可直接播放／暂停、停止、切换前后段、选择声音、调整语速和音量；各文件会分别保存段落播放位置。文件右键菜单的 `Audio Tutor` 子菜单和命令面板也提供朗读入口。

设置页的语音使用下拉选项，按“中英通用／中文／英文”标注，并显示声音人名和男女。新安装默认使用 `Andrew（男）` 多语言声音，适合包含中文正文和英文术语的混合内容；已有自定义 ShortName 会保留并显示为“已有自定义”。

点击播放器的下载按钮、右键菜单中的“保存为 MP3”，或运行“Edge TTS：将当前 Markdown 保存为 MP3”，可选择将全文音频保存到原笔记旁的 `<笔记名>-EdgeTTS.mp3`。导出在后台独立运行，期间切换笔记或关闭当前播放器不会中断任务；再次导出同一笔记会更新该文件。Markdown 标记、链接、图片、代码块、公式和提示 Callout 会在朗读前移除；播放与导出都需要网络连接。

### 公式详解与推导练习

公式详解只处理 MinerU Markdown 实际识别出的独立公式块。模型不得创造公式或重新编号；没有编号时使用稳定的顺序编号，并保留原文上下文供核对。

推导练习是独立三栏界面：左侧显示公式和上下文，中间是 Markdown／LaTeX 草稿区，右侧可以生成练习、请求三级提示并检查推导。草稿、练习、提示和检查结果保存在 `derivation-progress.json`，再次打开同一篇论文时恢复。

### 可编辑提示词

所有 Audio Tutor AI 提示词都位于 Obsidian 仓库中的：

```text
AI RSS Reader/rules/audio-tutor/
├── _common.md
├── rough-reading.md
├── formula-guide.md
├── derivation-exercise.md
├── derivation-hint.md
├── derivation-check.md
├── understanding.md
└── review.md
```

插件只创建缺失文件，绝不覆盖已有提示词。每次调用模型前都会重新读取，因此保存修改后无需重载插件。`_common.md` 与当前任务提示词组合使用；设置页提供“补充缺失文件”和“打开粗读提示词”入口。提示词中可以使用 `{{title}}`、`{{paperMarkdown}}`、`{{contentList}}`、`{{layoutData}}`、`{{formulaIndex}}`、`{{formula}}`、`{{formulaContext}}`、`{{currentDraft}}`、`{{previousHints}}`、`{{learnerBackground}}`、`{{targetMinutes}}`、`{{focus}}` 和 `{{outputLanguage}}` 等与任务对应的变量。

## 设置

- **AI 模型：**服务商、API Key、模型名称、API 地址；ChatGPT Plus/Pro (Codex) 的登录、状态检查、退出及 Codex 命令
- **RSS 来源：**添加、编辑、删除、启用或停用订阅源；“检测所有 RSS 源”会逐一检查全部已配置来源（包括停用项），并汇总显示正常、空订阅或具体错误
- **研究方向：**添加、编辑、删除、启用或停用方向
- **处理：**关键词预筛、保留不匹配文章、每源文章数、AI 批量大小
- **输出：**输出目录、文件夹命名、单篇保存后是否打开笔记、批量自动抓取检查间隔、Markdown/YAML 模板、Defuddle、BibTeX、PDF
- **MinerU PDF 解析：**可选 Token、模型、OCR／表格／公式选项及 Markdown、JSON、布局、模型、图片和其他文件的保存开关
- **Theory Paper Audio Tutor：**讲解语言、学习者背景、粗读时长，以及 Edge TTS 语音、语速、音调、音量和提示词入口
- **EZProxy：**开关、地址模板、登录、重新登录和清除会话

## 从 Python 版迁移

进入“设置 → AI RSS Reader F → 从 Python 版迁移”，可依次导入：

- `config.json`
- `data/research_profiles.json`
- `data/filtered_papers.json`
- `data/read_status.json`

点击对应的“选择…文件”按钮会从当前设置窗口打开系统 JSON 文件选择器（包括独立设置窗口）；选择或取消后，插件会自动清理临时选择控件。

可以迁移 RSS 源、模型设置、研究方向、历史分析和已读状态，且不会修改旧版文件。

## 数据存储

插件使用 Obsidian `loadData` / `saveData` 保存设置、文章、分析结果、已读状态和已处理链接。插件数据位于 `<Vault>/.obsidian/plugins/ai-rss-reader-f/data.json`；生成的文献文件位于用户配置的笔记输出目录。

阅读器在插件加载、状态保存及每小时检查时，将超时的未读和隐藏条目转为“已过期”，保留记录供恢复，不再删除条目。未读按首次抓取或恢复未读时间计算；隐藏按隐藏时间计算。感兴趣和归档条目永久保留；任一保留天数设为 `0` 可关闭对应状态的自动过期。不会删除 Markdown、BibTeX、PDF 或附件，已处理链接继续用于去重。

旧数据迁移：已有 `read=true` 或 `savedPath` 的文章进入归档，其余进入未读；已有五类状态保持不变。原“已读条目保留天数”配置沿用为“隐藏条目保留天数”（内部配置键仍为 `readRetentionDays`）。之前版本已经删除的条目无法恢复。

## 安装

需要 Obsidian 1.5.0 或更新版本。EZProxy 登录使用内置网页浏览器，需支持 Web viewer 的版本。本插件仅支持桌面版。使用 ChatGPT Plus/Pro (Codex) 还需要本机可执行的 Codex CLI，以及包含 Codex 访问权限的 ChatGPT 账号。

1. 执行 `npm run build`。
2. 创建 `<Vault>/.obsidian/plugins/ai-rss-reader-f/`。
3. 复制 `main.js`、`manifest.json` 和 `styles.css`。
4. 在“设置 → 第三方插件”中重新加载并启用插件。
5. 点击 Ribbon 的 RSS 图标，或从命令面板运行“打开阅读器”。

安装目录名必须与 `manifest.json` 的 `id` 一致，F 版为 `ai-rss-reader-f`；不要直接使用源码目录名 `obsidian-ai-rss-reader` 或 `obsidian-ai-rss-reader_f`。三个构建文件应直接位于该目录内，不能多套一层文件夹。同一库中只保留一份声明该 ID 的插件；F 版与原版使用不同的插件 ID、数据目录及阅读器/推导视图 ID，可独立识别。原有 `obsidian-ai-rss-reader` 目录无需修改。`author` 仅是作者信息，无需修改。已有设置请保留安装目录中的 `data.json`。

## 开发与构建

需要 Node.js 18 或更新版本。

```bash
npm install
npm run dev
```

生产构建会先执行 TypeScript 严格类型检查，再由 esbuild 生成 `main.js`：

```bash
npm run build
```

## 项目结构

```text
src/
├── ai.ts          # 模型接口、相关性分析与通用文本生成
├── audio-tutor-prompts.ts # 可编辑提示词初始化与变量渲染
├── audio-tutor-source.ts  # MinerU 完整性检查、图片和公式索引
├── audio-tutor.ts         # 学习 Note 与推导任务编排
├── audio-tutor-view.ts    # 三栏推导练习界面
├── codex-app-server.ts # ChatGPT/Codex 登录与 app-server 客户端
├── defaults.ts    # 默认设置和模板
├── edge-tts-player.ts # 粗读讲稿分段与 Edge TTS 播放
├── ezproxy.ts     # 内置网页浏览器登录与代理会话
├── literature.ts  # 正文、元数据、BibTeX、PDF
├── main.ts        # 生命周期、状态、EZProxy
├── rss.ts         # RSS / Atom 与关键词预筛
├── settings.ts    # 设置页和导入
├── template.ts    # Markdown 与 YAML 模板引擎
├── types.ts       # 数据类型
└── view.ts        # 看板、表格、详情弹窗
```

手动安装或 GitHub Release 需要 `main.js`、`manifest.json`、`styles.css`。版本号应在 `manifest.json`、`package.json` 和 `versions.json` 中保持一致。

## 可编辑的正文清洗规则

正文先由 Defuddle 提取为 HTML，再使用 `defuddle/full` 的 `createMarkdownContent()` 转成 Markdown，与 Web Clipper 使用相同的转换入口。标题、段落、图片、表格和参考文献脚注会转换为 Markdown；科学上下标及复杂表格等必要 HTML 会保留。

插件加载后，以及添加或保存 RSS 来源时，会在 **Obsidian 仓库** 中创建缺失的规则文件（不随笔记输出目录设置变化）：

```text
AI RSS Reader/rules/
├── _common.json
├── Nature.json
├── Nature Communication.json
└── Nature Electronics.json
```

`_common.json` 是通用规则。其他文件按设置中的 RSS **完整名称**匹配，例如 `Nature Electronics` 只读取自己的文件，不继承 `Nature.json`。每次采集重新读取文件；使用文本编辑器修改 JSON 并保存，下一次采集立即生效，无需重启。已有文件不会被初始化覆盖。改名后的 RSS 会创建新文件，原文件保留；历史文章仍使用其采集时的来源名称。名称中的路径分隔符、Windows 非法文件名字符、百分号及末尾点/空格会编码；普通中文、英文和中间空格原样保留。避免仅大小写不同的来源名称。

执行流程：通用规则的 HTML 操作 → 来源规则的 HTML 操作 → Defuddle 正文提取 → 图片/图注/表格/脚注保留设置和链接处理 → Markdown 转换 → 通用文本替换 → 来源文本替换。保留设置及 `restoreProxyLinks` 由来源明确填写的值覆盖通用值；未填写则继承。这里的“保留”指不额外删除 Defuddle 已提取出的内容，不保证恢复网站未加载或提取器已排除的内容。

可复制的完整示例见 [examples/cleaning-rules](examples/cleaning-rules)。下面展示自定义来源的语法（选择器需按实际网站修改）：

```json
{
  "version": 1,
  "name": "Example Feed",
  "enabled": true,
  "contentSelector": "article",
  "removeSelectors": [".advertisement", ".share-buttons"],
  "unwrapSelectors": [".text-wrapper"],
  "preserve": {
    "images": true,
    "captions": true,
    "tables": true,
    "footnotes": true
  },
  "restoreProxyLinks": false,
  "proxyHosts": {},
  "replacements": [
    { "find": "Read more on our website", "replace": "" },
    { "find": "^Advertisement[ \\t]*$", "replace": "", "regex": true, "flags": "gm" }
  ]
}
```

- `version` 必须为 `1`；`name` 必须与来源名称完全一致，通用文件则为 `_common`。其他字段可省略。
- `enabled: false` 跳过该文件的规则，仍执行默认 Markdown 转换和其他启用的规则。
- `contentSelector` 选取正文范围，保留页面元数据；可匹配多个区域，嵌套匹配不重复。省略时自动识别。选择器未匹配任何内容会提示并回退。
- `removeSelectors` 删除匹配元素及全部内容；`unwrapSelectors` 只移除标签，保留子内容。操作发生在克隆页面上，不影响页面显示、PDF/BibTeX 检索和元数据提取。
- `preserve` 的四个开关默认均为 `true`；`false` 分别删除图片、图注、表格、文献脚注及引用标记。关闭图片时仍可单独保留图注。
- `restoreProxyLinks` 根据抓取页与原文 URL 判断代理后缀，还原原文主机。`proxyHosts` 可添加其他已知主机映射，例如 `"doi-org": "doi.org"`。不对任意带连字符的域名做猜测，不改变登录和下载请求。关闭此项会保留代理链接。
- `replacements` 处理最终 Markdown，按数组顺序执行。默认是全局字面文本替换；`regex: true` 使用 JavaScript 正则（不写 `/.../` 分隔符），默认 flags 为 `g`，支持 `gimsu`。正则替换支持 `$1` 等捕获组。JSON 内的反斜杠须写成 `\\`，不支持注释或尾随逗号。

Nature、Nature Communication、Nature Communications、Nature Electronics 的新建默认文件保留全文、参考文献、扩展数据、补充信息和图表，不额外裁剪章节；启用已知 Nature/DOI 代理链接还原。未知来源默认采用通用规则及标准转换。默认配置旨在对齐 Web Clipper，实际结果仍会受网页内容、登录状态及 Defuddle 版本影响。

JSON 格式/字段错误、无效选择器、无效正则或清洗后为空时，本次采集会放弃整套自定义规则，使用原始页面进行默认 Markdown 转换，并在笔记“采集提示”中显示原因。不会覆盖错误 JSON。已有笔记不会自动重写。

验证命令：`node --test tests/*.cjs`，构建命令：`npm run build`。

## 已知限制

- 客户端渲染、验证码或特殊下载接口可能导致只能提取摘要。
- PDF 获取依赖页面元数据和可发现的 PDF 地址，不保证支持所有出版社。
- “下载补充材料”和“下载同行评审文件”默认开启，可在“处理与输出”中分别关闭。关闭正文提取仍会获取页面以发现已启用的 PDF 和附件。
- “补充材料文件类型”和“同行评审文件类型”分别提供复选框，可选择 PDF、DOC/DOCX、XLS/XLSX、PPT/PPTX、ZIP/GZ/TAR、CSV/TSV、TXT/XML/JSON/RTF、PNG/JPG/JPEG/TIF/TIFF、MP4/MOV/AVI。每类附件只保存其设置中选中的格式，全部取消则跳过该类附件；首次使用及旧配置升级默认全选。此设置不影响正文 PDF，不会删除已有附件或解压筛选压缩包内容。带明确未选扩展名的链接在请求前跳过；无扩展名的下载接口需先获取响应识别类型，未选类型不保存。附件列表页仍会解析，筛选同样适用于其中的文件。
- 补充材料识别 Supporting Information/Material/Data、Supplementary/Supplemental Material/Information/Data、Additional Files、Electronic Supplementary Material、Appendix、Source Data，以及“补充材料”“补充信息”“附录”等名称；同时识别常见的 `suppl_file`、`suppinfo`、`MOESM`/`ESM` 等附件路径或文件名。
- 同行评审识别 Peer Review、Review History/Process、Reviewer/Referee Reports/Comments、Editorial Decision/History、Decision Letter、Author Response/Rebuttal、Response to Reviewers，以及中文审稿报告、审稿意见和作者回复。匹配依据包括链接文字、标题、无障碍标签、URL 和附近的附件章节。
- 附件以 `{citekey}-supplementary-{序号}.{扩展名}` 或 `{citekey}-peer-review-{序号}.{扩展名}` 保存，笔记中按类别列出链接。支持 PDF、ZIP、Word、Excel、CSV、文本、图片及视频等常见文件格式；同一 URL（忽略片段）只下载一次。
- 附件下载复用 EZProxy 和浏览器会话 Cookie；HTML 附件列表页最多继续解析一层，每篇最多请求 100 个附件地址。PDF 验证文件签名，ZIP 和现代 Office 文件检查 ZIP 标识；其他格式依据文件名或响应类型判断。登录页、无法识别的格式和单个失败会写入“采集提示”，不影响其他文件保存。
- 不会自动操作只能通过 JavaScript 按钮触发的下载，也不保证所有出版社或独立数据仓库都可自动获取。没有匹配附件链接时不生成附件；自动识别可能遗漏非标准标签，或将正文附录、Source Data 归为补充材料。附件列表页跳转后的相对链接仍以请求地址解析，复杂跳转可能需要手动下载。
- EZProxy 和机构登录流程不同，会话过期后需要重新登录。
- 大量历史论文会增大 `data.json`；阅读器通过分页避免一次渲染全部数据。
- AI 结果质量取决于模型、研究方向描述和文章摘要。
- ChatGPT Plus/Pro (Codex) 依赖本机 Codex CLI、浏览器登录和 ChatGPT 方案限额；Obsidian 若无法继承终端 PATH，需要在设置中填写 `codex.exe` 完整路径。

## 致谢

- [Obsidian Sample Plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Defuddle](https://github.com/kepano/defuddle)
- 文献元数据与附件发现流程参考 Zotero 的元数据优先思路

## License

MIT
