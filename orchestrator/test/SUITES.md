# T-56 W7 测试套件清单（orchestrator/test/）

> 收敛标准（计划 W7）：七大 suite 全部有单测文件；verify-gate 五段（syntax/import/CLI/test/self-check）
> 全绿才算过闸；meta-test 四炸弹（ESM require / TDZ / 无限递归 / 注入模板引用泄漏）每闸必跑。
> 运行方式：`node --test orchestrator/test/*.test.mjs orchestrator/test/*/*.test.mjs`（verify-gate ④ 测试闸自动**递归**执行，0 用例视绿）。
> 注意：Node 24 下 `node --test <目录>` 会把目录当模块加载并报 `Cannot find module`，必须给文件列表或 glob。

| Suite | 测试文件 | 覆盖（回归债） |
|---|---|---|
| seat-permissions | seat-permissions.test.mjs | T-391 P1 每席权限模式 ask/auto（fail-closed）：默认 ask 拒静默放行、auto 显式才生效、gate 拒绝原样透传、损坏 JSON/缺文件/垃圾值全 ask、出厂 11 席全 ask、seat-loop 方案 C（仅 console-1888/gui-3081 串联；qwen 等不串联） |
| acp-bridge | acp-bridge.test.mjs | T-391 P3 ACP 桥（本地 stdio JSON-RPC 2.0）：initialize 握手字段+五席 mode=ask、tools/list 恰好 titan_task/titan_status、titan_task 全链路（fake adapter，agent=false 单轮）untrusted=true + provenance、agent=true 假工具块 policy_blocked 兜底、未知席位/空/超长 task → -32602、未知 tool/缺 name → -32602、未知方法 -32601 / 非法消息 -32600 / notifications 不应答、once() 坏 JSON → -32700 |
| cdp-client | cdp-client.test.mjs | connect() URL 保持 ws / onerror 非 RangeError / onopen / 重试上限 / 尝试级超时（C-01, DELTA-027/034） |
| orchestrate-helpers | send-check-expr.test.mjs, scan-args.test.mjs | sendCheckExpr 无裸标识符 + vm 行为等价（S-01）；forceLocalOnly 三组合（C-03） |
| scan-filter | scan-triage.test.mjs | 占位符/纯重构/建新文件默认拦 + --allow-* 放行（W4 分诊） |
| markers | markers.test.mjs | 后缀机制 / 无后缀兼容 / contaminated 三态 / splitEndMarkers（M-17） |
| titan-sanity | file-sanity.test.mjs | 协议标记入文件 / 体积减半 / node--check / JSON / import 冒烟（P-01/P-19 护栏） |
| autopilot-statemachine | autopilot-ferry.test.mjs, lock.test.mjs, cleanup-batch.test.mjs, titan-execute-w6.test.mjs | fixer 摆渡 NEEDS_FIX 步骤序（S-06）；单写者锁 wx/死锁清理/锁内重读比对（S-09/S-10/M-07）；PID 三重校验（S-12）；超时退避链 + BLOCKED 记账 + PROOF 强证明（P-11/P-12） |
| registry-paths | registry-paths.test.mjs, check-file.test.mjs, decision-api.test.mjs, already-resolved-proof.test.mjs | canonical work-orders 路径（S-07）；verify_cmd 扩展名分派（S-11）；decision-api 启动（C-02）；PROOF 逐字校验 fixture |
| output-sandbox | output-sandbox.test.mjs | T-145 工具输出沙箱：落盘字节+sha256 回读、摘要预算上限、错误/告警信号、按需检索、ledger 节省聚合、CLI 只回摘要 |
| skills-frontmatter | skills-frontmatter.test.mjs | T-146 技能元数据：目录名=frontmatter name、description 长度、五个工程技能在位、MIT 来源标注、工作流索引与 M1-M7 分工；T-155 起全量强制 frontmatter + version/requires/tests/provenance 四字段 |
| skill-quality | skill-quality.test.mjs | T-155 技能质量门：校验器规则（缺 frontmatter/坏 semver/name 不符/空 requires/shell 元字符/测试文件不存在/provenance 缺 ref/description 越界）、夹具目录计数、仓内 19 技能全绿回归、CLI 退出码 |
| run-events | run-events.test.mjs | T-153 Run 事件账本：run_id 形态、事件链 seq 递增、只追加、非法 run_id 拒写、payload 脱敏（密钥打码+长文本截断）、list 倒序、prune 保留策略、坏行不炸链 |
| test-runner | run-tests.test.mjs | T-161 共享测试运行器：框架探测（vitest/jest/npm-test/pytest/node:test/探测不到）、命令构造（含 last_failed 变体）、输出解析（node spec+TAP / vitest / jest / pytest）、退化安全（解析不到不谎报通过）、target 白名单拒危险串、实跑红/绿两态、CLI --json 与人读摘要、输出长度上限（省 token） |
| verify-profiles | verify-profiles.test.mjs | T-164 R4 verify 命令注册槽：配置结构、语言→profile 映射、扩展名推断、UNKNOWN 传播（缺 profile/缺能力/未知语言三种）、node/python syntax 实跑 PASS/FAIL、python 档不写 __pycache__（不污染被检仓）、CLI 退码 0/1/3 与用法错 2、pytest 禁 cache 环境、无 shell 元字符 |
| repo-scope | repo-scope.test.mjs | T-167 R7 目标仓范围：仓库根判定（不存在/非目录/无标记拒；.git 与 AGENTS.md 过）、越界判据 DELTA-012（根内真/根外假/.. 穿越假）、目录目标展开（取源文件/跳噪声目录/上限截断）、单文件原样返回、标记清单含 AGENTS.md（D:\V8 靠它通过） |
| lineage | lineage.test.mjs | T-165 R5 产物血缘：stage 枚举校验（合法/非法/空→null/大小写）、project 字符集校验、仓名派生（D:\V8→V8）、读取端容错（老产物无字段跳过不报错）、stage/project 组合筛选、CLI 单查与过滤 |
| intent | intent.test.mjs | T-166 R6 意图落盘：代码枚举与 design-specs/intent.schema.json 一致（防漂移）、机器人三档模式→intent 映射、非法 intent 抛错、字段名与 schema 一致、长文本截断 + 疑似密钥打码、落盘文件名带 epoch ms、内容回读、列表倒序、坏文件不炸 |
| catalog-alert-format | catalog-alert-format.test.mjs | T-372 model-catalog-sync 链同步告警拼接纯函数：kilo/ofm/anly 变更行生成 + frozen + 有/无 catalog msg 拼接 + ofm/anly 空数组回落 |
| headless-preflight | headless-preflight.test.mjs | T-373 headless 预检纯函数：健康/ TCP 不可达/空列表/401/500/2 次重试/8  attempts/键名回退（FREELLMAPI_API_KEY 优先，TITAN_FREELLM_API_KEY 兜底） |
| pipeline-stage | pipeline-stage.test.mjs | T-162 R1 生命周期编排：阶段目录名与顺序（stage-01-design…stage-04-deliver）、产物字段沿用 R2 冻结名 + 追加 evidenceLevel/notes、非法 evidenceLevel 拒、四阶段各落产物（implement 只出执行单不改业务文件）、--pipeline 串链四阶段 + evidence.json、缺需求退 2 / 无 pipeline 退 1、CLI --design 跑通 |
| skill-manifest | skill-manifest.test.mjs | T-151 技能 manifest：provenance 拆解（original/adapted/vendored/非法）、条目生成（name/slug/version/source/sha256/treeSha256/entrypoints）、readOnly 默认 true + write:true 才 false、manifest 生成（只含带 SKILL.md 的目录、按名排序）、差异比对（新增/变更/移除/未变）、apply 落盘 + CAS 期望哈希不符显式冲突、并发写冲突显式失败且不覆盖他端内容、verify 一致性校验、仓内 20 技能与磁盘一致、CLI status/build/apply/verify |
| write-gate | write-gate.test.mjs, write-gate-integration.test.mjs | T-153 高风险写闸：目标分类（宪法/台账/密钥/发布树/普通）、提案不落盘、未确认拒写、显式+attested 两种确认、TOCTOU 拒写、密钥只记账；接入点 edit-issue（attested/--defer）、safe-write（高风险拒写/--confirm 放行）、run-gate CLI（apply 前置确认、reject） |
| diagrams | diagrams.test.mjs | T-147 图表文档：三张图在位、自包含离线（无脚本/图片/远程字体）、aria-labelledby 可解析、title 为 svg 首子元素、索引齐全 |
| persona | persona.test.mjs | T-141 Persona：四层优先级（force > session > global > system）、[%None] 清除不穿透、未知 ID fail-closed、system 段末尾注入 + temp 标记 |
| task-card | task-card.test.mjs | T-171 任务卡纪律：证据分级枚举（firsthand/local_report/unverified，非法值显式抛错）、阶段枚举与阶段结果（code/artifact/release × PASS/FAIL/UNKNOWN）、任务卡字段白名单（未知字段/非数组显式抛错）、fix_rounds 非负整数、阶段语义矛盾（产物 PASS 但代码非 PASS / 发布 PASS 但产物非 PASS）、done 要求代码段 PASS、交叉验证 PASS 必配 firsthand（亲验与自报不可混）、一次修正后停止（fix_rounds>1 未移交他人报 issue，已移交放行）、历史条目缺分级只报 warning、YAML 任务卡渲染→解析往返（含中文/引号/冒号）、CLI 单条/--all/不存在退码 0/1/3、edit-issue 集成（新字段落盘 + 非法值退 2 不落盘） |
| model-health | model-health.test.mjs | T-172 模型健康注册表 + 分档派单：分档表结构校验（id 不重 / tier 合法 / 任务档位有 rule+acceptance）、探针四态（200+tool_calls → healthy / 200 无 tool_calls → tools=false / 429 → down / 缺 key 与超时 → unknown）、TTL 缓存（二次不重探、超 TTL 失效）、健康判定（healthy/stale/down/unknown）、派单建议（mechanical 优先 light 且同档内不限量平台优先 / down 与无 tool_calls 被排除 / architecture 只给 heavy）、渲染与 CLI（--no-probe --json 离线、未知档位退 2）；T-251 大上下文实战探针（buildCtxFiller 确定性、ctx 探针四态 ctx_ok/stream_incomplete/ctx_timeout/error、probeModels 白名单平台加探→fidelity=firsthand/refuted/referenced、needsContext 档位排除 refuted=REFERENCED 不许冒充 VERIFIED、ctxProbe 配置卫生=白名单只含不限量平台） |
| supervisor | supervisor.test.mjs | T-173 常驻子进程监督器：job 规范校验（id/command/restart/max_restarts/env 白名单拒密钥）、清单 upsert/list/remove、子进程 env 只传白名单、守护循环重启策略（never 不重启 / on-failure 仅失败重启 / always 重启）、真实子进程拉起与心跳状态、移出清单即杀、计划任务 install/uninstall 成对可用（Windows）、状态原子写盘、CLI add/list 往返 |
| web-seat-adapter | web-seat-adapter.test.mjs | T-429 座位装配层回归：SEATS schema（5 席位/id 唯一/https/cap 非空）+ buildSeatAdapters 全席 type=web_seat & execute/testEnvironment/readHistory + preambleFor 分流（qwen/chatgpt 专用、其余 WEB 默认）；不触 CDP/网络 |
| supervisor-job-logs | supervisor-job-logs.test.mjs | T-429/T-432 真实 spawn：job stdout/stderr 落盘 logs/<jobId>.out|err.log（supervisor 被杀也不丢）；exit≠0 时 last_error 从文件读回；静默退出带 file marker 不再现身为 null |
| supervisor-launch | supervisor-launch.test.mjs | T-186 supervisor 后台化：VBS 零窗口（窗口风格 0）、启动器禁杀进程、buildInstallArgs 必含 SYSTEM/HOURLY/wscript/VBS 且禁止 node.exe 直喂 schtasks |
| model-health-refresh | model-health-refresh.test.mjs | T-186 健康表保鲜调度：selectProbeIds 默认排除计量档（rpd 有值）/ includeMetered 放行 / free=false 排除；dry-run 列清单不探针——T-192 发抖治理改 --tiers 夹具驱动（旧版读活 model-tiers.json，活池内容一变断言就翻红，T-191 实证）；缺密钥优雅 missing_key 不抛栈；T-251 键名失配修复（仓内实为 TITAN_FREELLM_API_KEY，T-236 同类：白名单只认 FREELLMAPI_API_KEY 曾致健康表 9 天 missing_key 不保鲜） |
| artifact-gate | artifact-gate.test.mjs | T-175 产物级闸门四件套：①artifact-manifest（文件+大小+SHA256、字典序、指纹稳定、默认排除 node_modules/.git、missing/mismatched/extra 三类问题）②license-notice-check（NOTICE 解析 "<pkg>@<ver> <LIC>"、无依赖免 NOTICE、有依赖未署名 FAIL、禁用许可证 AGPL FAIL、许可证标识缺失 UNKNOWN、python requirements.txt 档、gui/installer 本期未实现 UNKNOWN）③anon-download-verify（页面/发布页/HEAD 302/完整下载+哈希字节/私有仓 404；哈希不符 FAIL、网络异常与缺期望值 UNKNOWN）④stage-gate（三段独立 PASS；前段 FAIL 而后段 PASS = 矛盾 FAIL；前段未判 + 后段 PASS = UNKNOWN；任一 FAIL → FAIL；未判 → UNKNOWN）、CLI 往返与退出码 0/1/2/3 |
| free-catalog | free-catalog.test.mjs | T-179 免费模型目录免维护：分类（:free/策展/付费）·分档推导（derived vs curated）·三类剔除（下架 delisted / 转收费 paid / 占位 placeholder）·判不了不剔除（UNKNOWN）·审计账本只恢复自禁行·落库幂等·探针语义（200/429 可用，404/500 占位，异常判不了）·OpenRouter 目录拉取失败不判下架·本地 id 转换与策展表加载 |
| alert | alert.test.mjs | T-179 告警通道：密钥装载（只取 KEY=VALUE/跳注释/不覆盖已有 env/缺文件不报错）·Telegram 配置缺失原因（缺 token / 缺 chat id）·发送成功计数 + 4xx 不重试 + 网络异常算失败不抛 + 无 token 不发 ·变更摘要（无变化 null / 有变化出文案）·掩码不明文泄露 |
| catalog-runner | catalog-runner.test.mjs | T-179 执行器：剔除并落库（已转收费 + 已下架，审计账本只记自禁行）·幂等（第二遍零动作）·入池（先插禁用，探针 OK 才启用，500 保持禁用）·目录拉不到则不判下架（判不了不剔除） |
| capability-proof | capability-proof.test.mjs | T-184 能力自证度量：空台账率值=UNKNOWN(null 不当 0)·完成率/复核率/证据率口径·缺 verifier 的条目拉低复核率（保守不虚高）·最近窗口按 done_at 时间排序（非文件顺序）·端到端耗时缺时间戳不进样本·四项达标才 PASS 且近期连续性为主判据·Markdown 报告含判定与不确定项 |
| speedtest-worker | speedtest-worker.test.mjs | T-180 自建测速 Worker：/alive 204 零带宽·/__down 精确 N 字节·超限截断 50MB·非法值兜底·无 bytes 参数走流式·no-store·404 |
| admin-quality-column | admin-quality-column.test.mjs | T-180 3002 质量列：load_quality_map 只透白名单元数据（不漏凭据）·文件缺失/JSON 损坏/非字典项都返回空不抛·合并键与落盘同源 config.quality_key·三端点都挂质量分 |
| hysteria2-guard | hysteria2-guard.test.mjs | T-364/T-365 配置生成逻辑回归：GEMINI_STICKY_TOLERANCE_MS≥10000 锚点存在（防 Google 二次验证）·DISABLED_SOURCES={'SSG'}（过期订阅）且 PAID_SOURCES={'糖果'}·tls_required_no_tls 拦截 TLS Required 协议缺 TLS 节点（hysteria2/tuic/trojan/anytls）·validate_semantics 强制报该类节点 TLS required·CURATED_SOURCES 限 ebrasha 100·BROWSER_UA 存在（UA 反爬兜底）·save_rules_cfg 原子替换不留半截 JSON |
| node-quality-scheduler | node-quality-scheduler.test.mjs | T-180 质量定时刷新调度器（Kilo 复核后）：非法 interval 回落 30（不许 1ms 死循环）·子进程超时强杀留痕·单轮异常不终止循环·状态文件分 last_success_at/last_error/consecutive_failures·UTF-8 用 StringDecoder·实跑一轮 ok=true |
| quality-column-hardening | quality-column-hardening.test.mjs | T-180 Kilo 复核后加固：质量排序键对脏数据免疫（不 500、不排前面）·quality_scored 统计整池口径统一·only_quality 时 total 与列表自洽·三端点挂质量·前端不许出现无分母的"已测 N 个" |
| pipeline-real | pipeline-real.test.mjs, pipeline-real-hardening.test.mjs | T-168 真实内容生产：design 真链（多席位 review→analyze→architect）落 stage-01、plan 从 architect 裁决推导 work-order、CDP 不可用降级 local-placeholder 显式不谎报、阶段间文件契约交接、并行席位互不阻塞 |
| exec-model-guard | exec-model-guard.test.mjs | T-168 执行链守卫：执行器二进制解析（PATH/仓库内两段式，缺→executor-binary-missing 记账）、落点路径白名单（isRepoRelativePath 拒盘符/绝对/../UNC/中文/空白）、delta 解析 CRLF 兼容 + 无落点 DELTA 不静默丢、输入三分法（占位/空/无裁决→BLOCKED 不报 PASS，真·全 REJECT 仍 PASS） |
| skill-wiring | skill-wiring.test.mjs | T-168 复盘机制：AGENTS M7 技能表必须为每个技能目录留行、「什么时候用」不许写"相关时使用"这类空话——没挂触发点 = 测试红 → verify-gate 拦住 |
| upload-confirm | upload-confirm.test.mjs | T-168 附件上传确认教训：CDP 调用成功 ≠ 文件上传成功；files=0 时确认必须失败；files>0 时确认通过 |
| client-runner | client-runner.test.mjs | T-187 spawn EINVAL：harness 解析不返回 .cmd（Node24 CVE-2024-27980）·有 npx-cli.js 走 node:npx-cli·多行 prompt 不进 argv（stdin 喂 dsh，防 Windows 换行截断）·残余 .cmd 护栏 code=126 可操作 stderr（不裸 EINVAL）·同名 .exe 改道 |
| verify-after-write | verify-after-write.test.mjs | T-192 写后验闸（用前验刃）：node --check/JSON.parse/UTF-8 严格解码·损坏词四模式（standalone 词界/cjk-word/isolated-cjk 插入指纹/en-in-cjk 中文行孤词，whisper/共享/Get-Item 不误报）·vaw-ok 行豁免与 allowPaths 整文件豁免·写盘事故指纹（NUL/U+FFFD/整文件 undefined/object-object 整行字面量）·CLI 退出码 0/1/2 与 --json；词表数据驱动 vaw-denylist.json（新词发现即追加） |
| titan-shell | titan-shell.test.mjs | T-192 shell 辅助一条命令：head（-n/stdin/UTF-8）·chain（&& 等价物：cmd /d /s /c + windowsVerbatimArguments 防双层转义假成功，遇非零即停并透传退出码）·eval（脚本必须走文件通道，拒内联）·b64write（委托 safe-write 字节通道+回读校验，反斜杠载荷不转义）·verify（委托 verify-after-write 退出码透传）·未知子命令退 2/--help 退 0 |
| dashboard-reset-password | dashboard-reset-password.test.mjs | T-192 dashboard 密码重置一条命令：hashPassword 与服务端 scrypt$salt$hash 同构·--list 只读列用户与会话计数·缺 --apply 是 dry-run 不写盘·--apply 经 stdin 重置+清该用户会话（他人会话不动）+DB 备份+回读验证·--generate 一次性显示新密码·未知用户退 1·密码永不进命令行（M5） |
| dol-scanner | dol-scanner.test.mjs | T-204 幻觉物理治疗·输出端扫描：无声明 GREEN（机械输出不误伤）·声明+真实输出证据 GREEN（robocopy 统计/True/Junction/测试计数/证据路径）·声明+零证据 RED（纯自述幻觉画像）·证据路径引用与测试计数放行 |
| staged-files | staged-files.test.mjs | T-204 钩子暴露的雷：git 暂存清单中文路径 quotepath 八进制转义（-z + core.quotepath=false + 引号兜底剥离）·非 git 目录空数组不抛 |
| migration-smoke | migration-smoke.test.mjs | T-206 迁移后真实启动冒烟闸：judgeCmd(退出0且含期望片段才通过/非零退出/输出不含期望=不通过)·judgePath(路径缺失/目标不符/目标相符)·每条命令必须带超时(防挂死)·junction 期望目标必须在 D 盘 |
| commit-msg-check | commit-msg-check.test.mjs | T-204 幻觉物理治疗·提交级证据闸：无声明放行·声明+暂存归档证据放行·声明+消息内证据路径放行·声明+零证据拦截并列出声明词·正文换行里的声明也算数·元提法不误报；T-255 增：DONE/状态: OK/测试通过 三词与 dol-scanner 共用 claim-patterns.mjs（防词表漂移） |
| headless-receipt | headless-receipt.test.mjs | T-255 收据外部锚回归：证据头字段齐全（prompt_sha256 真哈希 64hex/output_sha256/git_head/started/ended/evidence_grade）·旧假字段 prompt_sha 不再出现·篡改正文→账本哈希失配可检出·DOL_GRADE_TO_EVIDENCE_LEVEL 映射与台账 EVIDENCE_LEVELS 对齐 |
| t240-gate-regression | t240-gate-regression.test.mjs | T-255 T-240 证据闸回归（真跑 edit-issue CLI + 临时台账副本）：dol_verdict=RED / timedOut=true / code≠0 三类仍被拦（exit1），GREEN 收据头放行——证明三层升级+收据头没把旧闸喂瞎 |
| t258-cv-gate | t258-cv-gate.test.mjs | T-258 cv 真伪闸：cv 证据须含 headless 收据头（# client=/# code=0/# timedOut=false/# prompt_sha256=）或全文 VERDICT 判定行；cv-verifier≠owner；cv=pass 必配 evidence_level=firsthand。作者自述/自评/分级矛盾均拒绝（exit 1），真 kilo 判定放行 |
| pre-commit-manifest | pre-commit-manifest.test.mjs | T-258 pre-commit 技能 manifest 前置闸：暂存 .agents/skills/*/SKILL.md 时，skill-manifest 须与磁盘一致，否则 exit 1 并提示 apply；核心逻辑直接复用 verifyManifest，秒级、不 spawn |
| verify-receipt | verify-receipt.test.mjs | T-258 收据外部锚读侧：校验文件 stdout 段哈希与头 output_sha256 是否一致，以及 run-events 账本中是否存在匹配的 evidence.receipt 事件；篡改或账本失配 → MISMATCH，未锚定 → NOT-ANCHORED（仅警告） |
| m3-negative-block | m3-negative-block.test.mjs | T-255 M3 负结论锚格式合并防漂移：titan-session-retro 与 titan-handoff 共用同一字句（什么没用/证据哈希/invalidate_when/重试条件），单边改文案=红 |
| m4-handoff-fidelity | m4-handoff-fidelity.test.mjs | T-255 M4 交接保真双轴：titan-handoff 模板含「约束存活清单」（硬约束逐条+来源可追溯）与「覆盖对账」（未决事项全列+grep 源文逐字找回） |
| m5-refuter | m5-refuter.test.mjs | T-255 M5 对抗式复核默认开启：titan-code-review 与 titan-four-party-consult 含 refuter-per-finding（构造反例→复核证据→反驳失败才上报）+ 独立锚≥2 才能升级阻塞 |
| client-endpoints | client-endpoints.test.mjs | T-257 Kilo/Cline 端点漂移巡检闸：8787 双路径漂移检出退 2（只读不改文件）·`--fix` 修回 3001 + 时间戳备份 + JSONC 注释保留 + 复检退 0 ·可选文件缺失按 SKIP 不误报 ·损坏 JSON 报 PARSE-ERROR 不吐栈 ·`--json` 输出漂移计数 ·OpenCode 走 bili 前缀只报 INFO 不计漂移（治 T-255 断流复发） |
| skill-evolution（子目录 test/skill-evolution/） | extract-signals.test.mjs, step34.test.mjs, unified-diff.test.mjs, golden-corpus.test.mjs, pipeline.test.mjs, funnel.test.mjs | T-228 技能自演进行为闸（治 T-227「有目录没行为」）：①真实语料解析（黄金语料冻结 T-208=7 条 3critical/4high、T-168=4 条 1critical/2medium/1low，解析器丢信号即红）②中文 2-gram 聚类 + 跨技能合并须「技能关联 + Jaccard≥0.35」双条件（fp1/fp2 不得误并）③真 unified diff：10 用例全部 roundtrip + `git apply --check` 双验、context 不符必抛 ④E2E ①→⑤ 真闭环：真复盘→非零召回→簇→可 apply diff，L0 真跑 `node --test`（失败必须 passed:false、无测试文件必须 FAIL+missing_test、通过必须 true——拒假绿灯/假红灯）、回测失败拦截采纳 ⑤schema 校验：$ref 解析保持数组（oneOf 不得被静默跳过）、垃圾输入点名缺哪些必填字段 ⑥funnel 漏斗与误报率：空账本指标 null（未知≠0%）、分母 0 无定义、runId 幂等、垃圾计数记 null 不造假、账本损坏/版本不符拒写 ⑦ESM 坑：`NODE_TEST_CONTEXT` 泄漏致失败子测试退出 0、生成测试骨架不得用 require() |
| py-test-gate | py-test-gate.test.mjs | T-260 复盘沉淀：bin/ python 测试接入 verify-gate 第 ⑪ 段。收集规则（只认 bin/test_*.py、目录缺失返空）·解释器探活（只认 python3、坏候选不抛、无解释器返 null）·**红测试必判红**（闸门有效性反证，防永远绿的空闸）·超时判红（watchdog timeout，不挂死整闸）·失败完整日志落盘 tmp/py-test-fail-logs 且摘要只取尾部 4 行·中文输出强制 UTF-8 不乱码（PYTHONIOENCODING）·describeResult 跳过与失败摘要。执行器在 lib/py-test-gate.mjs（10 例） |

| wip-triage | wip-triage.test.mjs | T-273 开工闸：僵尸 WIP 巡检（治「不了了之」——既有闸门全在提交边界，沉默放弃从不经过任何闸）。三类判据（台账外悬空产物 / done 但 cv pending / in_progress 停滞）·台账号提取不误判（titan/triage 不算）·残骸后缀可在文件名中间（实录 index.js.bak-t274-20261103，$ 锚死会漏）·rename 记录吃掉原路径 ·tmp/ 豁免 ·只有高置信孤儿判失败（提示级不拦）·报告含结论行与台账号 |
| test-gate-report | test-gate-report.test.mjs | T-274 verify-gate ④ 测试闸失败口径：watchdog 超时被杀 vs 加载期崩溃必须给不同结论（旧口径一句话，errTag 从不进日志）·两种口径都带 errTag/exit/signal/耗时/上限（结论里说不出谁杀的=红）·有 ℹ 汇总时按用例红处理、解析不到用例名须显式声明·上限常量 ≥900s（实测套件 352s，旧 600s 余量不足一倍）·多行 [GATE] 说明供闸门日志打印。执行器/常量在 lib/test-gate-report.mjs（8 例） |
| dsh-loadout | dsh-loadout.test.mjs | T-275 常驻上下文按需化：按簇开关 profile 插件行（quant/browser/modlens/modsearch/coinglass），把 SDK 工具声明块从常驻改成按需。纯函数在 lib/dsh-loadout-core.mjs（10 例）：只做「定位 - id: 行 + 插入/删除一行 disabled: true」的最小手术（YAML 轮转不可逆，不解析整份）；enable 必须字节级还原（roundtrip）+ 认别人手写的 disabled 形状 + disabled:false 视为启用 + CRLF 不串 + 未知行报 row-not-found 不动文本 + clusterStatus 区分 enabled/disabled/absent/keep |
| dispatch-contract | dispatch-contract.test.mjs | T-332 统一派单纯策略测试：normalize 附件严格类型（对象/数组/NUL 拒绝）、routeTask 命中 deepseek（F1 键名回归）/ 浏览器类走 web / 重构类走 local、getAvailableSeats web 键=deepseek、checkBudget 默认 unlimited + 显式 budgetLimit 才比较、verifyDispatchResult、computePriorityScore 上限、validateAttachmentsFs realpath 根围栏（越界/超大/不存在/总量）、PolicyError |
| dispatch-queue | dispatch-queue.test.mjs | T-332 派单队列测试：单文件 queue.jsonl + mkdir 建议锁（fail-fast QUEUE_BUSY）、claim 只一人签、workLoop 假执行器注入（零副作用）、attempts 用尽→failed、legacy 日期目录合并迁移（跨零点不丢）、重复 runId 拒绝、releaseLease done/failed 语义；写入根 TITAN_DISPATCH_ROOT（测试隔离，不碰真实 run-events） |
| file-fence | file-fence.test.mjs | T-253 L3 §3.2 席位文件围栏：本地席（kilo/cline/opencode/harness）可写 orchestrator/、越界 design-specs/ 被拦、相对/绝对路径归一、SEAT_ROOTS 均为相对路径 |
| web-seat | web-seat.test.mjs | T-208 网页席行为契约 + T-354 L3 P0 send 前按钮可用性断言（waitForSubmitReady：present+enabled 才 click；ds-button--disabled → send_button_disabled 快速失败不回退 Enter；React 竞态轮询；缺失按钮旧 Enter 兜底；老式布尔响应零重试兼容；runSeat 不进入 waitComplete） |
| web-seat-ensure | web-seat-ensure.test.mjs | T-253 ensureDeepSeekSeat 单测 + T-354（采纳 ChatGPT 诊断 §B5/§C）：evaluate 静默失败（CDP error / exceptionDetails）→ 返回 ok:false 且 detail 指明失败原因（readPage/readEditor、JS_EXCEPTION/CDP_ERROR/NO_VALUE）；可见性判断 strengthening（isConnected + getComputedStyle + 祖先无隐藏） |
| web-seat-completion | web-seat.test.mjs | T-356 回复完成判定重构（waitForCompletion 状态机）：先见生成中信号（gen）→ 生成态消失 + 新节点识别（baselineCount 节点数增，重复文本也算新回复）→ 静默窗 quietMs → 返回最新文本；未配生成信号退化为文本稳定；SERVER_UNAVAILABLE / FAIL_FAST / TIMEOUT 均抛错 |
| web-seat-visible-match | web-seat-visible-match.test.mjs | T-421 selector 多匹配「可见优先」回归：buildVisibleMatchJS 双匹配选可见者（0×0 stale 跳过/顺序无关）/ 无可见返回 null / display:none·visibility:hidden·opacity:0·detached 全跳过 / selector 含引号 JSON 转义安全 / SINGLE_VISIBLE_EDITOR_JS 单可见返回+双可见拒（fail-closed）/ textarea setter 路径不变 |
| budget-hardstop | budget-hardstop.test.mjs | T-348 预算硬停模拟（临时账本造额度）：checkHardStop 超额拒绝 / checkBudgetHardStop 付缺席位 Budget exceeded / 免费席始终放行 / loadMonthlySpend 月聚合累计（monthTotal），含 WO-1 跨日用例 / getBudgetStatus usagePercent / checkBudgetAlerts 50/75/90% 阈值 info/warning/critical |
| reviewers-yaml | reviewers-yaml.test.mjs | T-253 L3 事故闸（2026-11-10）：reviewers.yaml 必须可解析（重复键/语法错即红）· reviewers_role 五席在位且条目内无重复键 · 网站席 response_selector 不得为 main · editor/submit/response/generating/file_input 的非空覆写必须逐字等于座位常量（yaml 与常量漂移即红） |
| spa-baseline | spa-baseline.test.mjs | T-386 网页席 E2E 真机教训（2026-11-15）：SPA 常年 readyState=interactive（===complete 判据恒 false → reload 风暴 + 基线恒空假 done）·同 URL 不 Page.navigate·基线读点接受 interactive·muse composer 选择器兼容英文 Message 与中文 信息（2026-11-17 muse.ai 实际为中文 locale） |

| evidence-receipt | evidence-receipt.test.mjs | T-390 收据锚完整性防线：archive/evidence 下两个 T-390 headless 收据（kilo-cv.txt 193c2d0 原始锚、kilo-cv-83f27e6.txt）必须 verify-receipt=OK；T-389 锚已被账本保留策略剪除允许 OK/NOT-ANCHORED；任何 MISMATCH/MISSING 即红 |
| lead-pipeline-cli | lead-pipeline-cli.test.mjs | T-400 机会账本四端通道：cmd/lead-pipeline.mjs 薄壳复用 lib 库；--help 列 12 子命令零退出；init/add/list/stats 临时账本端到端；闸门失败 ok:false+非零退出；未知子命令非零提示 |
| lead-bridge | lead-bridge.test.mjs | T-436 V2-002 lead→dispatch 桥：buildDispatchRequest 形状（runId sanitize + lead- 前缀 + metadata）、budgetLimit 仅有限正数写入、enqueueLeads 只入 status=lead（triaged/settled 跳过）、enqueue→workLoop→buildReport 全链路 passRate=1、DUPLICATE_RUNID 幂等（二次全 skipped）、minMatchScore 过滤低分（matchScore 非数字保守放行）、options.filter 拒绝分支不入队、路径字符串 ledger 分支（loadLedger）、部分成功混合 passRate=0.5、buildReport 无终态任务 passRate=null（不伪造 0%）、失败任务 failure-class 分类（failuresByClass.timeout）、formatReport 含 passRate 行；隔离策略：单一共享 TITAN_DISPATCH_ROOT + beforeEach 清队列/run-events（传递 import 使 query-string 防缓存无效） |
| lead-dispatch-cli | lead-dispatch-cli.test.mjs | T-436 CLI 通道契约：--help 列子命令零退出、status 缺 runId exit=2 + ok:false、report 在隔离环境 exit=0 且 passRate=null（不含未执行任务的伪造值）、chain（max-tasks=0）exit=0 且 bridge.status=ok、bridge --dry-run 预览 exit=0；spawnSync 全程绑定 TITAN_DISPATCH_ROOT / TITAN_RUN_EVENTS_DIR 临时目录，零仓库污染 |

| headless-receipt-prompt-sha | headless-receipt-prompt-sha.test.mjs | T-401 收据内容寻址：promptSha256 抽 lib；内联哈希文本/同路径不同内容必不同哈希（旧实现哈希路径串的回归）/不可读文件退回路径哈希不崩/空输入稳定 |

| titan-memory-mcp-decay | titan-memory-mcp-decay.test.mjs | T-400 防回退守护：提交闸的 orchestrator/test/ 发现不到 titan-memory/test-mcp-decay.mjs（该用例直跑子进程 MCP JSON-RPC，验证 memory_recall 暴露/使用 decay·explain、默认分支不回退）；本包装把内层测试纳入闸门发现范围，且剥掉 NODE_TEST_CONTEXT 防假绿；退出码非 0 = 红 |

特别项：
- gate-meta.test.mjs（四炸弹沙箱护栏证明，每次过闸必跑；沙箱 tmp/gate-meta 自建自清理）
- 端到端三件（不需常驻设施即可跑）：w3-web-smoke（需 CDP 9222，手动）、verify-gate CLI 冒烟段（自动）、landmine 沙箱（titan-execute-w6，自动）
- bin/ python 测试（`bin/test_*.py`，由 verify-gate ⑪ 段逐个真跑，不进 node --test 口径；无 python3 解释器时该段跳过）

统计口径：`node --test orchestrator/test/` 的「tests N / pass N / fail 0」；任何 fix commit 必须携带 ≥1 新测试（回归账本 R1）。
