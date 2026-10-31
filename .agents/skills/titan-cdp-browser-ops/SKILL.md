---
name: titan-cdp-browser-ops
description: "【浏览器】操作本机 CDP 浏览器（127.0.0.1:9222）驱动网页：多步向导与表单、API 优先原则、截图取证、坑库（SPA/React/OAuth/DigitalPlat）与安全红线。触发词：浏览器操作 / CDP / 注册账号 / 多步向导 / 填表"
version: 1.1.0
requires: node, cdp-browser-9222, playwright-core
tests: "manual: 用 cdp-drv.mjs 开一个标签页并回读标题"
provenance: original
---

# TITAN CDP 浏览器操作技能（坑库与模式库）

## 0. API first（置顶总则）

**能用 API 干的绝不点浏览器**——浏览器只用来"发现 API"（Network 抓 XHR）和"处理无 API 的交互"（OAuth 授权页 / 图形验证码）。拿到端点+token 后一律 curl/脚本。
- 实证：CF 加 zone / 加 DNS 记录 / 查 NS 全有 REST 端点（`POST /zones` 响应直接给 assigned NS，不必点四层向导；`CF_B_TOKEN` 已在 `titan_secrets.env`，11 权限；`$env:CLOUDFLARE_API_TOKEN` + `npx wrangler whoami` 验证可用）。
- DigitalPlat 系同理（nic.us.kg 遗产 API 谱系）：DOM 点击前先看 Network 面板里的 XHR，直接 curl 复刻。
- 反例纪律：确认流程后的重复执行/多步向导切 playwright-core/MCP 脚本，别留在裸 eval（2026-10-11 数字域名注册会话全程裸 eval 属退步）。

## 1. 环境（2026-10-11 实测 + 2026-10-12 增补）

- 启动：`<workspace>\orchestrator\启动 CDP 浏览器.bat`（playwright chromium，`--remote-debugging-port=9222`，**persistent profile `chrome-cdp-profile`——登录/验证态跨重启保留**）。
- 断连（ECONNREFUSED 9222）= 浏览器被关。重跑 .bat 即可，标签页异步恢复（等 ~8-15s 再 list）。**勿自启**，让用户跑 .bat。
- **动浏览器前先查代理栈**：`Test-NetConnection 127.0.0.1 -Port 10810`（浏览器走系统代理；代理挂了先拉 sing-box，否则页面只出 `chrome-error://chromewebdata/`）。
- CF 双账号可**同一浏览器共存**：A=gcczfy（8f8f3623…，512688.xyz 与代理 Worker 所在）、B=geczfy（b093bcb2…）。账号归属用 **account-pinned URL**（`/b093…/…`）消除歧义；`/profile/*` 用户级页面归属不明，**避免用**，优先 Account API Tokens（`/b093…/api-tokens`）。
- CF 仪表盘**语言会中英漂移**：所有按钮匹配必须双语（'继续激活'/'Continue to activation' 这类成对写）。
- 用户新开会话句式："你去看看/帮我注册/托管到 X" = 授权操作其账号；动生产账号前报告清楚操作对象。
- **网页席名单唯一事实源 = `orchestrator/reviewers.yaml`（enabled:true 生效）**：当前 = gemini / deepseek / qwen；grok `enabled:false` 备胎。技能里不硬编码席位名，操作与诊断细则见 §8。

## 2. 工具

**首选 `tmp/cdp-drv.mjs` v2**（零依赖，T-58 升级；人工/会话侧默认驱动）：
- `node tmp/cdp-drv.mjs list` — 列标签页（含 `#id` 前缀）
- `new <url>` / `close <selector>` — 建/关 tab（封装 `PUT /json/new`、`/json/close`，绕 `window.open` 被拦）
- `eval <selector> "<expr | @表达式文件>" [--raw]` — 求值；**默认自动防泄漏包裹**（direct eval 进 async IIFE 作用域：同一页二次 eval 不再撞 `var` 重声明；表达式完成值自动返回）；需要旧行为加 `--raw`
- `nav <selector> "<url>" [--chars N]` — 导航+等 6s+dump innerText（默认 3500 字，输出带 title）
- `shot <selector> <file.png>` — 截屏留证（Page.captureScreenshot）
- **selector 规则**：`#<targetId前缀>` 精确匹配；否则 URL 子串，**全浏览器唯一才放行**（多命中即列候选报错——治 OAuth/重定向撞车：曾命中 `github.com/login?client_id=…` 而非主会话页）。
- **表达式一律走 `@文件` 模式**——彻底消灭 PowerShell 引号/括号地狱（少写一个 `}` 都会 SyntaxError）。含非 ASCII 的 expr 文件一律 UTF-8（ASCII 编码会把中文变 `???` → `SyntaxError: Nothing to repeat`）。

**CDP HTTP 端点速查**（实战验证）：
```
GET    /json/list                  # 全 tab（含 targetId）
PUT    /json/new?<urlencoded-url>  # 建 tab（GET 405；绕过弹窗拦截）
PUT    /json/close/<targetId>      # 关 tab
PUT    /json/activate/<targetId>   # 前台切换
```

**重型/多步流程用 playwright-core（^1.64.0）或 Playwright MCP（@playwright/mcp 0.0.83，T-58 已装）**：
- 接入：`chromium.connectOverCDP('http://127.0.0.1:9222')` 复用登录态；自动等待/定位重试/对话框/截图；样板 `tmp/pw-test.mjs`。
- MCP：已接 `opencode.json` 的 `mcp.playwright`（`--cdp-endpoint http://127.0.0.1:9222`，25 个 `browser_*` 工具：navigate/snapshot/click/fill_form/tabs/evaluate/screenshot…）；OpenCode 重启后加载。分工：探索侦查用 cdp-drv（快、透明），确认流程后的重复执行/向导切 MCP 或 playwright-core。

**专项小工具（tmp/，T-58）**：
- `inject-secret.mjs <selector> <css> [--env NAME | --file <base64文件>]` — 密钥回填表单：base64→页面内 `atob`→原生 setter+事件；密钥不进命令行/表达式/URL。验证只回读长度。
- `xhr-spy.mjs <taburl子串> [--ms N] [--filter <url子串>] [--body]` — CDP 网络层抓 XHR/fetch（**替代 mitmproxy**，不动系统代理栈）；UI 状态骗人时抠真实 API 调用与 payload → curl 复刻。

**`orchestrator/cdp-client.mjs` 状态（T-58 修正）**：其"强制 wss + 失败递归"双断点已在 **T-56 W2.1 修复**（`cdp-client.test` 5/5），`orchestrate.mjs` 正常使用（C-01 修复实证：`[WS] connected`）。人工交互驱动仍首选 cdp-drv（轻、行为透明）；不要再按旧"禁用"条目处理。

## 3. 通用坑库（全部实录）

1. **表单 POST 导航会销毁 eval 上下文** → 驱动返回 "(no output)" / EVAL_EXC "context destroyed" = **大概率成功跳转**，是信号不是失败；接着 dump 新页即可。
2. **`input[type=text]` 属性选择器匹配不到无 type 属性的输入框**：用 `[...document.querySelectorAll('input')].filter(i => i.type === 'text' && i.offsetParent !== null)`（property 过滤 + 可见过滤）。
3. **React 受控输入必须原生 setter**：`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` + `dispatchEvent(new Event('input',{bubbles:true}))`（加 change 更稳）；直接 `.value=` 不触发 React 状态。select 同理用 `HTMLSelectElement.prototype`，textarea 用 `HTMLTextAreaElement.prototype`。
4. **disabled 的提交按钮点击无效**（katabump ALTCHA 验证周期内就这样）：轮询等状态字（如 "Verified"）再点；必要时强制 `btn.disabled=false` 后点（服务端还会再验，无风险）。
5. **CF 向导的 Confirm 弹层**："Add records later / Confirm"——确认无记录继续，点 Confirm。
6. **CF dash 没有 `<main>` 标签**：取正文用 `document.body.innerText` 的尾段 slice 或 `main1` 标记定位；SPA 懒加载要 sleep 4-10s 再取。
7. **"Create Token" 等控件可能是 `<a>` 不是 `<button>`**：搜索范围含 `a, [role=button]`，取 innerText 最短的最内层元素点击（冒泡到可点祖先）。
8. **ALTCHA 验证码**（proof-of-work 型）点选框后自算自验，等 label 变 "Verified"；提交时可能重验一轮，"Verifying... 100%" 停留是正常周期。
9. **CF add-site 直链**（`/domains/add-site`）会被弹回 /home：从 `/domains` 页点 "Add domain" 按钮进入向导。
10. **PowerShell 调 node 传参**：双引号包整段；JS 里只用单引号；有 `$`、反引号、双引号的内容一律进文件走 @模式。
11. **重渲染吞掉已填值**（S1）：select/input 设好后 SPA 重渲染 `.value` 回默认——**提交前在同一个 eval 里先读值再点按钮**，读回不是预期值就中止；不要"填完等几秒再点"。
12. **提交成功 = 表单清空**（S2）：点提交后输入框全空常是**成功**信号，别当失败重填；最终验证走权威查询（DNS/API），不是 UI 文案。
13. **非 React 表单原生 setter 偶发 `Illegal invocation`**（S4，跨 realm）：两路都试——先 `el.value=v` 直赋 + change，不行再原生 setter；以"同 eval 内读回值"为准。
14. **懒加载正文**（S5）：页面打开 10s 内 `body.innerText` 可能只有侧栏；sleep 4-12s 或对已知结构直接 querySelector 探测（比 innerText 可靠）。
15. **弹层 disabled 按钮有语义**（S6）：CF 套餐确认框 Confirm 永久 disabled = Free 已是当前套餐、**无可确认变更**；正确动作是 Cancel 关掉，不是硬解 disabled。碰到 disabled 先回答"它在等什么状态"。
16. **OAuth 新上下文不共享登录**（§9 详版）：DigitalPlat 发起的 GitHub OAuth 在新的 login 页仍显示登录表单——把**已登录的 GitHub tab 直接导航到 authorize URL**（从 return_to 抠参数），cookie 生效自动批准。
17. **Gmail 验证码落"推广"tab**（E3）：主收件箱看不到；先点"推广"再找行，或直接搜寄件人；`location.reload()` 会复位视图。
18. **前端换代杀死旧 selector**（CF2/18，T-58）：站点换富文本编辑器后，**旧选择器静默失效不报错**——`#prompt-textarea` 从 chatgpt 消失，替换为 `.ProseMirror`（contenteditable div，非原生 textarea）。特征=editor_selector 找不到元素→派发时"已发"但正文无变化→capture 超时。诊断：eval `!!document.querySelector(sel)`，选错换新探；**长期对策=selector 表落 reviewers.yaml（唯一事实源），DOM 换代时只改 yaml 不改代码**。

> 变量二次声明（C3）与子串撞车（C2）已由 cdp-drv v2 **机制化**（auto-IIFE / 唯一性放行）——但 `--raw` 模式或手工 CDP 时仍要自觉。

## 4. Cloudflare 仪表盘模式库

**add-site 全链**（2026-10-11 实测）：`/domains` → "Add domain" → "Connect a domain" → 填域名（原生 setter）→ Continue → 扫描记录（0 条→Confirm "Add records later"）→ 选 Free → "继续激活" → nameserver-directions 页拿分配 NS 对 → katabump/注册商侧改 NS → 回向导点 "我更新了我的域名服务器" → zone Active。
- **zone 建好 ≠ 向导走完**（CF2）：填完域名 Continue 后 URL 已到 `/<zone>/select-plan`，**zone 实体已存在**（列表显示 Pending setup）；剩余向导可跳——直接 nav `/<zone>/manual-entry`（DNS 手录页）→ 加记录 → "Continue to activation" → 落到 nameserver-directions 拿 NS 对。
- **加购弹层 APO $5/mo**（CF3）：套餐页 Confirm 前先读 `input[name=add_addon_apo].checked`，必须 false 才 Confirm。
- **会话中途过期**（CF4）：dash 突然 302 到 `/login`（空 body），直接 re-nav 出 chrome-error——检测到 login 跳转就重走登录；re-nav 前 sleep 3s。
- **加 zone 零绑卡**（CF5）：B 账号加 zone 全程无绑卡无验证（与"勿给 B 绑卡"红线不冲突）。
- **新 zone 证书 Pending Validation(TXT) 加速法**：加一条占位 proxied A 记录（apex → 192.0.2.1），HTTP 验证通道即通，数分钟签发。验证：`curl -sv --resolve <域名>:443:<CF边缘IP>` TLS 握手成功=证书在位。
- DNS 记录表单字段名：`input[name=name]`（placeholder "Use @ for root"）、`input[name=ipv4_address]`；类型默认 A；Proxy 默认开。
- **账号 API 令牌**（Account API Tokens，账号钉定 URL）：创建令牌 → 模板选 **"编辑 Cloudflare 工作进程"/Edit Cloudflare Workers（11 权限）** → 无有效期 → 审核 → 创建 → **令牌只显示一次，当场从 DOM 捕获**（regex `[A-Za-z0-9_-]{35,120}` 过滤，cfat_ 前缀）。附赠 R2 S3 凭证一并存。
- 验证令牌：`$env:CLOUDFLARE_API_TOKEN=<从文件读>; npx wrangler whoami` → "logged in with an Account API Token" 即通过；env 覆盖不动本机 OAuth 配置。

## 5. 免费（子）域名接入 Vetting 清单（顺序执行）

1. **PSL 检查（决定性前提）**：`curl -s https://publicsuffix.org/list/public_suffix_list.dat | grep <父域>`——在 PSL 才能被 CF 免费版收为 zone（`xxx.父域` 才算 registrable）。不在 PSL 的一律进不了 CF 免费版（is-a.dev/afraid/no-ip 等只做记录注入的都死在这）。
2. **NS 委派能力**：服务必须能让用户自设 NS（CF free 只支持 Full setup）。
3. **服务方尽调**：运营主体（whois/条款/公司信息）、条款是否禁代理/CDN 用途、每账号免费额度、反多账号条款。
4. **信任分级**：父区控制方理论上可重委派劫持 → 免费子域**只用于低敏感层**（如 free-pool 备援），付费组/安全敏感域名钉死自有域名。
5. 落地后全链验证：公网 dig NS → proxied 记录解析返回 CF anycast → TLS SNI 握手。

## 6. katabump / kdns.fr 实录（2026-10-11）

- `kdns.fr` 在 PSL（提交人 Thibault Lapeyre contact@katabump.com）；运营方=法国非营利协会（SIREN 923 962 724，条款 2026-10-08 更新）。Article 16 管 kdns.fr：禁违法/仿冒商标/冒充，**不禁代理用途**；Article 6 **一个账号限一个免费服务**——已用掉勿再注册。
- 注册流：dashboard.katabump.com → My domains → Order a domain（`/domains/create`）→ 名字（3-63 字符）→ NS 模式二选一（KataBump NS=即时托管 / **External NS=下单后自配，CF 场景选这个**）→ ALTCHA → Order。已注册后也可在 manage 页 "切换到外部 NS"（action=switch_to_external）。
- External NS 表单：`input[name="nameservers[]"]`（2-6 个）→ 填 CF 分配对 → Save → `?success=ns` → 父区委派**秒级**生效。
- `/domains/custom/create` 是给外部已注册域名免费挂他们 NS 的入口，不是注册 kdns.fr 的地方。
- 成果：`daddsdffdsagff.kdns.fr` → CF B 账号 zone Active + Universal SSL 已签（Zone ID 75ad1c5678caa5845dc92853cc08ee6f，NS julissa/mario.ns.cloudflare.com）。

## 7. 安全纪律（M7 在浏览器场景的落法）

- **令牌/密钥落盘走 write 工具**（`titan_secrets.env`，已被 `**/titan_secrets.env` gitignore 强制排除），**不走命令行**（避免进 shell 历史）；验证时从文件读入 env 变量再调进程。
- **密钥回填表单走 `tmp/inject-secret.mjs`**（base64 → env/文件通道 → 页面内 atob）；**禁止**把密钥明文拼进 eval 表达式/命令行（E2：密码含 `"`、`[`、`|` 拼 JS 必炸，字节通道是唯一安全解）。
- 令牌一次性展示必须**当场 DOM 捕获**；后续消息/报告不回显完整值。
- 浏览器自动化前向用户报告操作对象（哪个账号/哪个页面）；用户在场可随时请求人工代点（混合模式）。

## 8. 网页席操作与诊断（四方会诊/8方查错/交叉审问共用）

**名单与登录**：唯一事实源 `orchestrator/reviewers.yaml`（enabled:true）；当前 gemini / deepseek / qwen（grok 备胎 enabled:false）。登录态在 persistent profile 跨重启保留；`orchestrate.mjs --probe` / `--ensure-tabs` 检查（NEEDS-LOGIN 判据是启发式，gemini 可能误报，以实际 DOM/截图为准）。`--review` 只取 enabled；`--scan` 的网页席从 `reviewers_role` 取并由代码过滤 enabled。

**选择器表（T-57 实测；改 DOM 后重探）**：

| 席 | url_match | editor_selector | submit_selector | 附件 | regen |
|---|---|---|---|---|---|
| gemini | `gemini\.google\.com` | `.ql-editor[contenteditable="true"]` | `button[aria-label="发送"]` | `input[type=file]` + `上传和工具` 菜单 | 重做 |
| deepseek | `chat\.deepseek\.com` | `textarea[placeholder="Message DeepSeek"]` | `[role="button"].ds-button--circle.ds-button--primary` | `input[type=file]` | 待探 |
| qwen | `chat[.]qwen[.]ai` | `textarea.message-input-textarea` | `button.send-button` | **drag 拖拽**（见附件通道）；direct 假成功 | hover `.mode-select-open`→菜单「上传附件」；regen 按钮文案=「重新生成」 |
| grok（备胎） | `grok\.com` | `[contenteditable="true"][role="textbox"]` | `button[aria-label*="Send"]` | `input[type=file].hidden` | Regenerate |
| chatgpt（architect） | `chatgpt\.com` | `.ProseMirror`（`#prompt-textarea` 已死） | Enter（submit_method=enter） | `input[type=file]`（多个，chooser/drag） | hover 后菜单 |

**弱回复处理（T-71 2026-10-21 实战修正）**：解析不出合法 severity+title finding → 触发刷新/重发（maxRegen=1；chatgpt 菜单需 hover 后读父级 aria-label）。prompt 禁带"无问题输出 []"毒句（会让 grok/chatgpt 直接回空数组）。
- **短文本一律不判弱（<200 字符）**：弱回复的根因往往不是"模型没给 findings"，而是**页面根本没渲染完**——deepseek 首轮 `waitForResponse` 超时 → T-62 兜底只抓到 **61 字符**空壳 → 判弱 → 找不到刷新按钮 → **同页重发 prompt** → 同一页两条用户气泡 = **重复气泡**（T-71 观察项实证复现）。短文本门槛同时覆盖 gemini 合法回 `[]`（=无问题）。
- **`generating` 标志不可靠**：停止按钮文案检测（stop/停止/cancel）在 deepseek/grok 上常为 false 而正文仍在生成 → 判据要用**文本长度**，不要依赖按钮。
- **同页重发兜底也要再判生成态**：重发前重抓快照，generating=true 则不重发，改为继续等回复到稳。

**response-capture 时序诊断（T-57 教训，重要）**：raw md 短/是侧栏 UI 垃圾 **≠ 席位死**——派发侧可能"响应未到就取文本"（`responseActivity.hasResponse=false` 时仅抓到 95 字符侧栏）。诊断顺序：**截图 → 会话历史 → raw md**；w9 的"gemini 沉默"实为答案已完整到达（G-01/G-02 评审在对话里），deepseek "超时"实为 `waitForResponse` 时效问题。判断席位健康看对话历史里有没有完整回复。

**配额**：`orchestrator/limits.json` `dispatch_cdp=2/日`（派发输出有 `[LIMITS] dispatch cdp N/2` 行可核）；面额宝贵，冒烟用 fixture 不灌真席。

**附件通道（T-58 实证修正，勿再按旧"一律 direct"处理）**：网页席扫描**不再一律 direct**——按 `reviewers.yaml` 的 `upload_strategy` 字段分席：
- **direct 直传**（gemini/deepseek）：`DOM.setFileInputFiles` 后**必须确认轮询**（正文出现文件名主名前 8 字符）；files.length=0、XHR 零请求=假成功，不能只看返回码。
- **drag 拖拽**（qwen，实证唯一可靠路径）：`DataTransfer` + `dispatchEvent(new DragEvent('drop'))` 投递；`input[type=file].change` 从不触发（input 隐藏 + React 拦截），直传必假成功。`uploadByDragSim` 自动确认。
- **chooser 拦截**（gemini 备用）：`Page.setInterceptFileChooserDialog`→`fileChooserOpened` 事件→`DOM.setFileInputFiles(nodeId)`（事件注册必须在点击前，否则竞态）。
- **确认针 = 文件名主名前 8 字符，不含扩展名、不含点号**——qwen 芯片渲染格式是 `"orchestrate .mjs"`（主名和扩展名之间插空格），`slice(0,8)`+"orchestr" 才是唯一安全针；任何含点号的前缀（如 `"orchestrate."`）在 qwen 上假阴性。
- prompt 禁带"无问题输出 []"毒句（会让席位直接回空数组）。

## 9. OAuth 跨站授权模式（DP3 固化）

- 现象：A 站已登录，A 站发起的 B 站 OAuth 在**新上下文**里仍显示 B 站登录页（另一个 tab 的登录态不共享）。
- 解法：把**已登录的 B 站 tab 直接导航到 authorize URL**（从登录页的 `return_to`/redirect 参数里抠出完整 authorize 链接），该上下文 cookie 生效 → B 站自动批准并回调。
- 佐证：DigitalPlat KYC 第二次从带会话的 tab 发起，GitHub 直接放行，回调 URL 带 `oauth_notice=github_kyc_verified`。
- 注意：回调页可能显示"通知"后**自关并吃掉会话**（DP2）——重新登录再走一遍是幂等的，第二次必过。

## 10. DigitalPlat（dpdns.org 系）域名生命周期

- **DP1 KYC 是第二道门**：注册账号+邮箱验证 ≠ 能注册域名；点"注册域名→注册"才跳 `/user/kyc`（GitHub OAuth）。
- **DP2 KYC 回调吃会话**：第一次 OAuth 回调页自关后回 dashboard 变登录页；**在已登录会话里再点 KYC** 即通过。
- **DP4 免费额度规则随时变**：qzz.io 现已消耗付费插槽（旧教程还说免费）；us.kg/xx.kg 暂停/收费；qd.je 不在 PSL。注册前必读页面"插槽记账"区 + 当场 PSL curl 验证。
- **DP5 域名字符串漂移**：流程锚定名与最终注册名可能不一致（多手操作/重渲染期间输入漂移）→ **单一事实源 = 注册成功页显示的域名**，以它为准回改 CF；每跳一次页面核对一次。
- **DP6 NS 更新 UI 滞后**：表单清空（成功）但页面仍显示旧 DNS 文案 → 权威验证 `Resolve-DnsName <域名> -Type NS -Server <注册局NS IP>`（dpdns.org 权威 = ns1-4.digitalplat.org），别信 UI 也别信本地缓存。
- 续期规则以站内页为准（历史上约 120 天），到期前回站检查。

## 11. 网页席多席并发纪律（2026-10-21 T-71/T-72 实战固化，用户指令）

**11. 标签页预算 = 席位数 + 1（文件/附件页）**：5 席 → 6 页上限；只用 4 席 → 5 页。**超过预算即存在同席位重复页，必须关闭**。
- 只关「`url_match` 命中同一席位且不是当前使用页」的 tab，**绝不碰用户自己的其它标签页**。
- 原因：浏览器开的页越多越吃内存、渲染争抢越狠，直接压出席级故障——实测 deepseek 空回复 61 字符、kilo 300s 超时、opencode Bun 崩溃 exit 3。
- 落点：`orchestrator/lib/scan-entry.mjs`（启动时治理 + 每次重试前治理）。

**12. 各席错开启动**：网页席 **10 秒**间隔、本地 CLI 席 **5 秒**间隔。5 席同时刷新页面 + 发送附件会把网页卡死（页面越多越卡 → 席级超时）。错开后总时长 +N×10s，但每席不再被卡，实际完成更快。

**13. 重试前先关重复页，再重试**；上传失败重试 **3→2 次**（单次重试成本 ≈ fresh-chat 30s + 上传 30s + 附件确认 30s ≈ 90s，第 3 次纯烧时间）。

**14. 提效参数**（实测有效）：upload 基线超时 300s→**240s**、waitForResponse grace 60s→**30s**、发送确认窗 30s→**15s**。有回复的席实测均在 60~120s 内落地；超时仍有 T-62 全文兜底，不丢内容。

**15. 裁决（architect）链路的两个硬约束**：
- `runArchitect` 只读 `reviews/<id>/layer-b/delta.md`（不依赖 layer-a）→ **scan 产物可直接送裁决**，但 dispatchId 正则必须放行 `scan-<base36>`（否则「scan → 去重汇总 → ChatGPT 裁决」整条链走不通）。
- ChatGPT 新 UI 把用户气泡渲染成 **"You said:" 引用块**放在 assistant 消息内部 → `innerText` = prompt 回显 + 回答。剥离：① prompt 尾部插 `markerEnd(dispatchId)`，捕获侧按 marker 切；② marker 缺失（长 prompt 被折叠）→ 兜底取「最后一个 DELTA id 所在行行首之后」。判定条目必须用 **`lastIndexOf(did)`**（回显在前、回答在后），判定词正则要放宽到同行 `DELTA-001: accept` 格式（只认行首会把真裁决全判成 missing）。

**16. 配额与节奏**：网页 AI 席发附件有**每日用量限制** → 跨席位并发实战必须按日排队，不要在同一日反复跑多轮 scan；本地验证优先用 fixture / 离线断言（如 T-71 弱闸逻辑 11/11 离线断言）省额度。

**17. 席位工具路径会静默失效**：Kilo VS Code 扩展静默自动更新（实测 7.8.3 → 7.8.15），硬编码版本目录必 `spawn ENOENT` → 须按扩展目录扫最新语义版本（`orchestrator/scan-flow.mjs` resolveCommand 已做）。

## 12. 视频字幕取证（YouTube 反爬绕过，2026-10-21 实证）

**场景**：需要读某个 YouTube 视频的**指定时间段**内容（做调研/取证），且本机 yt-dlp 撞上反爬。

**yt-dlp 会依次遇到的三道墙**：
1. `Sign in to confirm you're not a bot` → 需要 cookies（`--cookies-from-browser brave`；本机 Brave 无 YouTube 登录态时仍会失败）
2. `The page needs to be reloaded` → player client 被拒，试 `--extractor-args "youtube:player_client=web_safari"`（此时若报 "Requested format is not available" 说明**已拿到流**，只是格式选择问题）
3. 字幕直链返回 **HTTP 200 但长度 0** → 缺 `signature`/`pot` 签名参数；`--write-auto-subs` 可能直接 **429 限流**

**可靠路径（CDP 浏览器，2026-10-21 实测走通）**：
1. 浏览器打开视频页 → `window.ytInitialPlayerResponse` 可读 `videoDetails`（标题/时长/简介）与 `captions.playerCaptionsTracklistRenderer.captionTracks[]`（含人工字幕与自动字幕轨）
2. **让播放器自己发字幕请求**（它带正确 token）→ 从**网络面板**取那条 `timedtext` URL（含 `signature` + `pot` + `xorb`）
3. 页内 `fetch(该URL)` → `fmt=json3` → 按 `events[].tStartMs` 切片取目标时间段（同一 startTime 的多行要合并）
4. 注意：音频流的 `streamingData.adaptiveFormats[].url` 可能为 `null`（YouTube 新版 SABR 流保护），此时只能走字幕；真要转写音频需另找带签名的直链

**提示**：`ytInitialPlayerResponse` 里能读到字幕轨 ≠ 能取到内容——缺签名参数时 fetch 回来是 0 字节；`performance.getEntriesByType('resource')` 里通常也查不到 timedtext（不在 resource buffer 内），**从网络面板拿 URL 最稳**。

## 13. 维护条款（用户 2026-10-11 授权）


- 用户授权：①浏览器/效率工具可自装（工作区内、官方源、装完记录并提交）；②**可复用新知识（坑库/模式/工具用法/账号注册要点）可自主新增或更新本技能并提交，无需每次请示**。
- 更新方式：改本 SKILL.md → git commit（`[fix] 技能更新：<摘要>`）。新技能建 `.agents/skills/<name>/SKILL.md`（YAML frontmatter 格式与本文件一致）。
- 完整实战源档：`.agents/skills/titan-cdp-browser-ops/浏览器操作实例-20261011-Cline.md`（C1-C5/S1-S6/CF1-5/DP1-6/E1-3 原始编号在此，SKILL.md 已按主题归并）。
- 本技能由 opencode 会话创建（2026-10-11，kdns.fr 落地会话全实录）；2026-10-12 T-58 升级为操作枢纽（工具链 v2 + 席位操作 + OAuth/DP 章节）。
