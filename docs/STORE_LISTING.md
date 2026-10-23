# Chrome 应用商店上架文案（照抄即可）

## 商店简介（Store Listing → 描述，≤132 字符）

```
在小红书评论区一键查看任意回复的完整对话链：从楼主到该回复逐层展开上下文，点击跳回原文定位。
```

## 详细描述（Detailed description）

```
小红书把楼中楼评论「压平」展示，回复内容又不自动引用原文，官方「查看对话」还只显示两个人——
于是你看到一条回复时，往往不知道它到底在回谁、前面说了什么。

XHS Thread Tracer 就是为解决这一个问题而做的：还原任意一条回复的完整来龙去脉。

【怎么用】
每条评论右下角会出现一个「🔗对话链」按钮，点击后右侧滑出面板，展示这条评论所属主楼的对话树：

· 手风琴式逐层展开：默认只显示楼主与通往你点击的那条回复的祖先路径，其余分支收起
· 每个有回复的节点带「▸ 展开 N 条回复」开关，点击逐层展开
· 同层互斥：同一层展开一个分支时，兄弟分支自动收起，面板始终聚焦一条对话路径
· 点击任意一行，自动滚动到页面原文位置并高亮
· 自动展开楼中楼：点击按钮时代替你点开页面已有的「展开」按钮，数据到齐后面板自动刷新
· 节点内会显示该条评论的配图缩略图，点击可查看原图

【数据来源】
插件自身不发起任何网络请求。它通过旁听页面已经发出的评论接口响应（fetch / XHR，只读）
来还原精确的父子关系，接口未覆盖时回退到页面 DOM 推断。全部处理在浏览器本地完成，
不采集、不存储、不上传任何数据，也不申请任何权限。

【已知限制】
· SSR 直出的评论需滚动触发分页后才有精确数据，期间走 DOM 推断
· 昵称重复时 DOM 推断可能挂错父节点（接口模式无此问题）
· 未展开的楼中楼不在 DOM 中，需先展开
· 仅支持小红书网页版，不适用移动端

仅供个人阅读辅助，不用于批量数据采集；请遵守小红书用户协议与相关法律法规。
```

## 其他字段

| 字段 | 填法 |
|---|---|
| 类别 | 生产力工具（Productivity） |
| 语言 | 中文（简体）—— 勾选 zh-CN |
| 隐私政策 URL | `https://github.com/hummingg/xhs-thread-tracer/blob/main/docs/PRIVACY.md` |
| 是否面向儿童 | 否 |
| 是否需要付款/订阅 | 否 |

## 隐私规范（Privacy practices）

| 问题 | 填法 |
|---|---|
| 此项是否使用用户数据 | **否**（不收集任何数据） |
| 数据是否离开设备 | **否** |
| 是否用于用户未察觉的用途 | **否** |
| 权限说明 | 无权限（`permissions: []`），无需填写任何权限理由 |

---

# 单一用途（Single Purpose）合规自证

> 商店政策原文：*An extension must have a single purpose that is narrow and easy-to-understand.*
> 若审核员就此提问，可直接把下面这段贴进申诉 / 说明框。

**本扩展的单一用途是：还原小红书评论区中任意一条回复的完整对话上下文（discussion thread context）。**

一件小事，一种做法。所有功能都直接服务于这一个目的，不存在任何与之无关的特性：

| 功能 | 与单一用途的关系 | 是否可独立 |
|---|---|---|
| 对话链树面板（逐层展开 / 同层互斥） | **目的本身**：把被压平的对话链还原出来 | 是（核心） |
| 点击行跳回原文并高亮 | 让用户回到页面原文确认上下文，是同一目的的**定位环节** | 否 |
| 自动展开楼中楼 | 负责**拿到**完整对话数据；只有替用户点开已有「展开」按钮才能补齐链条，是同一目的的**取数环节** | 否 |
| 节点内配图缩略图 | 配图是评论内容的一部分，缺了它对话节点就不完整；仅渲染在树节点行内，**无独立入口、无独立 UI** | 否 |
| DOM 推断兜底 | 接口不可用时达成同一目的的**备用实现路径**，不是额外功能 | 否 |

据此，本扩展不属于「功能大杂烩」：
- 无广告、无注入第三方内容、无跳转、无外链推荐、无账号体系、无付费
- 无统计埋点、无遥测、无远程代码（MV3 下也不允许），全部逻辑随包分发
- 权限列表为空（`permissions: []`），不申请 `tabs` / `cookies` / `webRequest` 等敏感权限
- 匹配域名仅 `https://www.xiaohongshu.com/*`，不作用于其他任何站点

**唯一可能被视为越界的是配图缩略图**，但它只是评论正文的组成部分——一条带图评论若只显示文字，上下文依然缺失，因此它服务于同一目的且没有独立入口。

---

# Permission justification（权限理由，照抄）

> 后台提示：*A permission is either one of a list of known strings... or a match pattern giving access to one or more hosts.*
> 我们 `permissions` 数组为空，**唯一**被要求解释的是 `content_scripts.matches` 里那条 `https://www.xiaohongshu.com/*`。

## 英文版（推荐，直接粘贴，约 950 字符）

```
Host access to https://www.xiaohongshu.com/* is required to inject a "Thread" button next to
each comment on Xiaohongshu note pages. Clicking it opens a side panel that renders the full
parent-child chain of that reply, which the site itself flattens and does not expose. The content
script reads only (a) comment API responses the page has already received, observed read-only by
wrapping window.fetch and XMLHttpRequest, and (b) comment text already rendered in the page DOM.
Requests whose URL does not match the comment API path are passed through untouched and their
bodies are never read. All parsing happens locally in the browser: nothing is collected, stored
or transmitted anywhere, and the extension issues no network requests of its own. The permissions
array is empty; no tabs, cookies, storage, webRequest or any other API permission is requested.
A narrower path pattern was not adopted because the Xiaohongshu web app is a single-page app where
note pages are served under more than one path shape (/explore/{id}, /discovery/item/{id})
depending on the entry point, so restricting to one would silently break the others. activeTab
is not sufficient because the feature must inject automatically at document_start on page load,
without requiring the user to click the toolbar icon each time.
```

## 中文版（若后台为中文界面）

```
需要访问 https://www.xiaohongshu.com/* 以在小红书笔记页的每条评论旁注入「对话链」按钮；点击后在
侧边面板展示该条回复的完整父子对话链（平台本身将楼中楼压平且不提供该功能）。脚本仅读取两类数据：
(a) 页面自身已接收的评论接口响应——通过只读包装 window.fetch / XMLHttpRequest 观察得到；
(b) 页面已渲染的评论文本。URL 不匹配评论接口的请求一律原样放行，从不读取其内容。全部解析在浏览器
本地完成，不采集、不存储、不上传任何数据，也不发起任何额外网络请求。manifest 的 permissions 数组
为空，未申请 tabs / cookies / storage / webRequest 等任何 API 权限。之所以未把路径收窄：小红书网页版是
单页应用，笔记详情页在不同入口下路径形态不同（/explore/{id}、/discovery/item/{id}），限定其一会导致
其他入口静默失效。activeTab 不足以满足需求：本功能需在页面加载时（document_start）自动注入，不要求
用户每次点击工具栏图标。
```

## 为什么这么写（对应审核员的三个检查点）

| 审核员在查什么 | 我们的回答 |
|---|---|
| 哪个用户可见功能需要这项权限？ | 「对话链」按钮 + 侧边面板，只在笔记页评论区出现 |
| 拿到数据后怎么处理？ | 本地解析成树，不落盘、不外发；非评论接口连 body 都不读 |
| 为什么不能更窄？ | SPA 多入口路径不唯一；activeTab 无法 document_start 自动注入 |

**注意**：文案里「非评论接口的请求原样放行、从不读取内容」这句是对代码行为的如实陈述——
`hook_main.js:38` 与 `:55` 处先 `isCommentApi(url)` 判断，不匹配就不调用 `forward()`，
也不执行 `res.clone().json()`。如果以后改了这段逻辑，文案必须同步改，否则属于虚假陈述。

## 可选加固（我建议不做）

把 `matches` 收窄成 `https://www.xiaohongshu.com/explore/*` + `/discovery/item/*`，
审核面会更干净。但代价是：小红书一旦调整笔记页 URL 结构，插件会静默失效且无提示。
单一域名（非 `<all_urls>`）+ 空权限数组本就是最低告警档，为这点收益引入失效风险不划算。
