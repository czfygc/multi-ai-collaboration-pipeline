// lib/session-send.mjs — T-61 P6b 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-6b：reviewer 单席发送链——上传三件/基础链 8 件/运行体/上传模式包装，共 15 函数）：
//   块1（原 L376-1126）：前置注释 L376-385（文件上传流程说明）+
//     resolveFileInputNode/uploadFileToTab/uploadByDragSim（上传三件） +
//     runTab/attachAndEnable/navigateIfNeeded/injectPrompt/submitForm/computeResponseTimeout/
//     checkAndRetrySubmit/captureScreenshot/saveResponseMarkdown/dumpReviewerLog（基础链） +
//     runTabBase（内嵌 regen 质量闸/重试链）/runTabUpload（upload 模式包装）。
//   export 面 2 符号：runTab/runTabUpload；其余 13 个零块外引用，模块内部化。
//     块外引用实证 runTab L1290/L1477、runTabUpload L1474/L1840（行址=baseCommit 35b7f4e）。
// 依赖（块内自由标识符扫描实证 tmp/t61/p6b-depscan.mjs；误报已逐一剔除）：
//   node:fs writeFileSync/promises(fsPromises)、node:path join、
//   constants ATTACH_CONFIRM_TIMEOUT_MS/DRAG_STEP_DELAY_MS/MAX_REPORT_CHARS/
//   RESPONSE_STABLE_DEFAULT_MS/RESPONSE_STABLE_UPLOAD_MS/TIMEOUT_ARTIFACT_FACTOR/
//   TIMEOUT_ARTIFACT_UNIT_KB/TIMEOUT_INLINE_BASE_MS/TIMEOUT_INLINE_MAX_MS/
//   TIMEOUT_UPLOAD_BASE_MS/TIMEOUT_UPLOAD_MAX_MS、
//   session-nav attachToTarget/navigateToFreshChat/screenshotTab/waitForResponse、
//   prompts buildEditorStateScript/buildInjectScript/buildRegenClickScript/
//   buildSnapshotScript/buildSubmitScript、send-check-expr buildSendCheckExpr、
//   upload-verify buildAttachmentConfirmExpr/uploadViaChooserIntercept/waitAttachmentConfirmed。
//   剔除误报：CDP 仅存在于注释与 'CDP-dispatchDragEvent' 字符串（无 new CDP 实例化）；
//   mode/prompt/artifact/BODY_INNERTEXT_FULL 仅注释与字符串字面量；
//   'Target.attachToTarget' 协议字符串非标识符引用（真实调用实证 L720）。
//   疑似死代码 helper（attachAndEnable/navigateIfNeeded/injectPrompt/submitForm/
//   checkAndRetrySubmit/captureScreenshot/saveResponseMarkdown/uploadByDragSim 等）照搬不删、
//   不导出（计划 §6.9：拆中发现的问题另立 delta，不顺手修）。
// 入口 import 收窄：session-nav 行剔 waitForResponse；constants 行剔 10 常量（TIMEOUT_*/
//   DRAG_STEP_DELAY_MS/ATTACH_CONFIRM_TIMEOUT_MS/RESPONSE_STABLE_*）；prompts 行剔 4 构建器；
//   send-check-expr 行（L371）/upload-verify 行（L374）整行删除（块外零引用实证）。
// 回迁 import：runTab/runTabUpload 新增一行 `import { runTab, runTabUpload } from './lib/session-send.mjs';`
//   插入 CDP import 锚（L370）之前（原 import 收窄后入口不再持有该二符号，须回迁）。
import { writeFileSync, promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { ATTACH_CONFIRM_TIMEOUT_MS, DRAG_STEP_DELAY_MS, MAX_REPORT_CHARS, RESPONSE_STABLE_DEFAULT_MS, RESPONSE_STABLE_UPLOAD_MS, TIMEOUT_ARTIFACT_FACTOR, TIMEOUT_ARTIFACT_UNIT_KB, TIMEOUT_INLINE_BASE_MS, TIMEOUT_INLINE_MAX_MS, TIMEOUT_UPLOAD_BASE_MS, TIMEOUT_UPLOAD_MAX_MS } from './constants.mjs';
import { attachToTarget, navigateToFreshChat, screenshotTab, waitForResponse } from './session-nav.mjs';
import { buildEditorStateScript, buildInjectScript, buildRegenClickScript, buildSnapshotScript, buildSubmitScript } from './prompts.mjs';
import { buildSendCheckExpr } from './send-check-expr.mjs';
import { buildAttachmentConfirmExpr, uploadViaChooserIntercept, waitAttachmentConfirmed } from './upload-verify.mjs';

// ---------- 文件上传（upload 模式专用） ----------
// 步骤：
//   1. 若 upload_strategy="menu_then_upload"：点击 upload_button_selector，
//      在弹出菜单里点击 upload_menu_item_text 匹配的项，等 file input 出现。
//   2. DOM.enable + DOM.getDocument + DOM.querySelector(file_input_selector)
//   3. DOM.setFileInputFiles 注入文件路径
//   4. 等 upload_wait_ms
//
// 任一环节失败抛错，runTabUpload 捕获后写 UPLOAD_FAILED 占位 md 并返回失败态；
// 不会回落到 inline（artifact 以附件身份发送，prompt 中不含全文，回落会丢失上下文）。
async function resolveFileInputNode(cdp, sessionId, selector, maxTries = 5) {
  try { await cdp.send('DOM.enable', {}, sessionId); } catch (e) { console.warn('[WARN] DOM.enable 失败（继续走 DOM.querySelector）: ' + e.message); }
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
  const rootNodeId = doc.root.nodeId;
  for (let i = 0; i < maxTries; i++) {
    const q = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector }, sessionId);
    if (q && q.nodeId) return q.nodeId;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('file input not found: ' + selector);
}

// T-89：bundle manifest 解析——artifact 为 *.manifest.json 且 kind=titan-bundle 时，
// files 数组（绝对路径）即本轮要上传的全部真实文件；否则回落单文件语义。
async function resolveUploadPaths(artifactAbsPath) {
  if (/\.manifest\.json$/i.test(artifactAbsPath)) {
    try {
      const m = JSON.parse(await fsPromises.readFile(artifactAbsPath, 'utf8'));
      if (m && m.kind === 'titan-bundle' && Array.isArray(m.files) && m.files.length) {
        const paths = m.files.map(f => (typeof f === 'string' ? f : f && f.path)).filter(Boolean);
        if (paths.length) return paths;
      }
    } catch (e) { /* 解析失败按单文件（manifest 本身）处理 */ }
  }
  return [artifactAbsPath];
}

// T-89：多文件确认——每个文件名主干（前 8 字符）都出现在正文才算全部挂上（AND）。
function buildMultiConfirmExpr(paths) {
  return paths.map(p => buildAttachmentConfirmExpr(p)).join(' && ');
}

// T-89：附件确认表达式轮询器（共用：直传后验证 / 拖拽后验证）……
async function uploadFileToTab(cdp, sessionId, reviewer, artifactAbsPath) {
  // 优先使用 DOM.setFileInputFiles（4 方中最稳定）
  if (!reviewer.file_input_selector) {
    throw new Error('reviewer missing file_input_selector: ' + reviewer.name);
  }

  // T-89：解析 bundle manifest → 本轮全部待传文件路径（单文件时即 [artifact]）
  const upPaths = await resolveUploadPaths(artifactAbsPath);

  // 路径 D（T-58）：upload_strategy=drag——跳过直传（qwen 实证静默假成功：files=0、零上传
  // 请求）与 chooser（事件竞态未归），直接拖拽投递。实证：qwen 拖拽后芯片
  // "orchestrate .mjs 205.0 KB" 出现（拖拽有效，先前误报 UPLOAD_FAILED 是确认针误配）。
  if (reviewer.upload_strategy === 'drag') {
    const drag = await uploadByDragSim(cdp, sessionId, reviewer, upPaths);
    return { ok: true, method: 'drag', bytes: drag.bytes };
  }

  // 路径 A（T-58）：menu_then_upload 席走 chooser 拦截投递（qwen 唯一实测有效通道；
  // 实现已下沉 lib/upload-verify.mjs 保 R3 体量——直传 setFileInputFiles(nodeId) 对
  // qwen 静默假成功：files=0、XHR 监听零上传请求，故菜单席禁用直传首选）。
  if (reviewer.upload_strategy === 'menu_then_upload' && reviewer.upload_button_selector && reviewer.upload_menu_item_text) {
    const chooser = await uploadViaChooserIntercept(cdp, sessionId, reviewer, artifactAbsPath).catch((e) => {
      console.log('[WARN] ' + reviewer.name + ' chooser 路径失败: ' + e.message + '，降级其他路径');
      return null;
    });
    if (chooser) {
      if (chooser.ok) return { ok: true, method: chooser.method, waitMs: reviewer.upload_wait_ms };
      console.log('[WARN] ' + reviewer.name + ' chooser 路径未确认（正文未见文件名），降级直传/拖拽');
    }
  }

  // Gemini/DeepSeek/Grok 的 input[type="file"] 常驻 DOM（可能在 shadow 内），优先直接 set
  let nodeId = null;
  let directError = null;
  try {
    nodeId = await resolveFileInputNode(cdp, sessionId, reviewer.file_input_selector, 5);
  } catch (e) {
    directError = e;
  }

  if (nodeId === null || nodeId === undefined) {
    // 尝试 fallback 选择器（如 .hidden-file-input）
    try {
      nodeId = await resolveFileInputNode(cdp, sessionId, 'input[type="file"]', 5);
    } catch (e2) {
      directError = e2;
    }
  }

  // 对于 Gemini 这类需要菜单打开输入的场景
  if (nodeId === null || nodeId === undefined) {
    if (reviewer.upload_strategy === 'menu_then_upload' && reviewer.upload_button_selector) {
      try {
        // 1. 打开上传菜单
        const btnSel = JSON.stringify(reviewer.upload_button_selector);
        const btnExpr = `(() => { const b = document.querySelector(${btnSel}); if (b) { b.click(); return { ok: true }; } return { ok: false }; })()`;
        const btnR = await cdp.send('Runtime.evaluate', { expression: btnExpr, returnByValue: true }, sessionId);
        if (!btnR.result.value || !btnR.result.value.ok) {
          throw new Error('upload button click failed');
        }
        await new Promise(r => setTimeout(r, 1500));

        // 2. 点击菜单项
        if (reviewer.upload_menu_item_text) {
          const menuText = JSON.stringify(reviewer.upload_menu_item_text);
          const menuExpr = `(() => {
            const MENU = ${menuText};
            const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="option"], button, li, a')];
            const target = items.find(el => (el.innerText || '').includes(MENU));
            if (target) { target.click(); return { ok: true }; }
            return { ok: false, candidates: items.map(el => el.innerText).slice(0, 10) };
          })()`;
          const menuR = await cdp.send('Runtime.evaluate', { expression: menuExpr, returnByValue: true }, sessionId);
          if (!menuR.result.value || !menuR.result.value.ok) {
            throw new Error('menu item click failed: ' + JSON.stringify(menuR.result.value));
          }
          await new Promise(r => setTimeout(r, 2000));

          // 3. 再次尝试查找文件输入（此时菜单已打开，input 应该出现）
          try {
            nodeId = await resolveFileInputNode(cdp, sessionId, reviewer.file_input_selector, 3);
          } catch (e3) {
            // fallback
            try {
              nodeId = await resolveFileInputNode(cdp, sessionId, 'input[type="file"]', 3);
            } catch (e4) {
              directError = e4;
            }
          }
        }
      } catch (e5) {
        directError = e5;
      }
    }
  }

  // 如果还是没找到，尝试拖拽模拟兜底
  if (nodeId === null || nodeId === undefined) {
    try {
      const drag = await uploadByDragSim(cdp, sessionId, reviewer, upPaths);
      return { ok: true, method: drag.method, bytes: drag.bytes };
    } catch (eDrag) {
      throw new Error('file input not found and drag-sim failed: ' + reviewer.name + ' (' + (directError && directError.message) + ')');
    }
  }

  // T-89：files 数组直传（CDP setFileInputFiles 原生支持多路径）
  await cdp.send('DOM.setFileInputFiles', { files: upPaths, nodeId }, sessionId);
  await new Promise(r => setTimeout(r, reviewer.upload_wait_ms || 3000));
  // T-58：setFileInputFiles 静默假成功实证（qwen：files=0、无上传请求、无芯片，会话里模型
  // 亲口说"没收到附件"）——set 后按"正文出现附件文件名"轮询确认；未确认即用拖拽兜底
  //（用户实证 qwen 支持拖拽入对话框）；拖拽仍不成则错误冒泡为 UPLOAD_FAILED，绝不假成功
  //（假成功会让 "Missing Source Code" 式回复被解析成有效 finding 骗过弱回复门）。
  // T-89：多文件 AND 确认（每文件名主干都要出现），超时按文件数放宽。
  const confirmExpr = buildMultiConfirmExpr(upPaths);
  // T-89 实证（ec209896）：多文件芯片渲染可超 12s（deepseek 直传/qwen 拖拽均迟到），
  // 上限提至 30s，避免把"慢"误判成 UPLOAD_FAILED。
  const confirmTimeout = upPaths.length > 1 ? 30000 : 6000;
  if (await waitAttachmentConfirmed(cdp, sessionId, confirmExpr, confirmTimeout)) {
    return { ok: true, method: 'direct', files: upPaths.length, fileInputSelector: reviewer.file_input_selector, waitMs: reviewer.upload_wait_ms };
  }
  console.log('[WARN] ' + reviewer.name + ' 直传未确认（正文未见文件名），降级拖拽模拟');
  const drag = await uploadByDragSim(cdp, sessionId, reviewer, upPaths);
  return { ok: true, method: 'drag-after-direct-noop', files: upPaths.length, bytes: drag.bytes };
}

// 拖拽模拟兜底：使用 CDP Input.dispatchDragEvent 投递真实 File 对象。
// 4 方均支持：CDP dispatchDragEvent 产生 isTrusted=true 的 drop 事件，
// DragData.files 绝对路径会被 Chrome 转换为真实 File，
// drop 后 Gemini 的 attachment-preview-wrapper 在 1-3s 出现。
async function uploadByDragSim(cdp, sessionId, reviewer, artifactPaths) {
  const editorSel = reviewer.editor_selector;
  if (!editorSel) throw new Error('drag-sim requires editor_selector: ' + reviewer.name);
  // T-89：接受路径数组（bundle 多文件一次拖入）；兼容单字符串入参
  const paths = Array.isArray(artifactPaths) ? artifactPaths : [artifactPaths];
  const filename = paths.map(p => String(p).split(/[\\/]/).pop()).join('\n');
  // 测量编辑器中心坐标（drop 到编辑器区域才能触发 Gemini 的 dropzone 处理）
  const coordsExpr = `(() => {
    const ed = document.querySelector(${JSON.stringify(editorSel)});
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2 };
  })()`;
  const coords = await cdp.send('Runtime.evaluate', { expression: coordsExpr, returnByValue: true }, sessionId);
  if (!coords.result.value || !(coords.result.value && typeof coords.result.value.x === 'number' && isFinite(coords.result.value.x))) {
    throw new Error('failed to measure editor coordinates: ' + reviewer.name);
  }
  const x = coords.result.value.x;
  const y = coords.result.value.y;

  // 权威 DragData schema（probe-v24/v25 验证）；T-89：多文件改为逐文件顺序投递——
  // qwen 实证单次多路径 DragData 只落地 3-4/8（其 drop 处理器不完整消费多文件），
  // 逐个单文件 drop 是全席已证稳通道（gemini 8/8、qwen 探针单发均过）。
  const seqDeliver = async () => {
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const oneName = String(p).split(/[\\/]/).pop();
      const oneData = {
        items: [{ mimeType: 'text/plain', data: oneName }],
        files: [p],
        dragOperationsMask: 1
      };
      await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data: oneData }, sessionId);
      await new Promise(r => setTimeout(r, DRAG_STEP_DELAY_MS));
      await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data: oneData }, sessionId);
      await new Promise(r => setTimeout(r, DRAG_STEP_DELAY_MS));
      await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data: oneData }, sessionId);
      await new Promise(r => setTimeout(r, 700));
    }
  };
  try {
    await seqDeliver();
  } catch (e) {
    throw new Error('dispatchDragEvent failed: ' + e.message);
  }

  // T-58 泛化：不再写死 gemini 的 .attachment-preview-wrapper——统一走附件确认表达式
  //（文件名入正文即判挂成功；保留 gemini wrapper 作为 OR 之一）。
  // T-89：多文件时逐文件 AND 确认（首文件保留 gemini wrapper 通道）。
  const confirmParts = paths.map((p, i) => buildAttachmentConfirmExpr(p, i === 0 ? '.attachment-preview-wrapper' : undefined));
  const attachExpr = confirmParts.join(' && ');
  const attachTimeout = paths.length > 1 ? 30000 : ATTACH_CONFIRM_TIMEOUT_MS;
  if (!(await waitAttachmentConfirmed(cdp, sessionId, attachExpr, attachTimeout))) {
    throw new Error('drag-sim: attachment not confirmed after ' + attachTimeout + 'ms polling');
  }
  return { ok: true, method: 'CDP-dispatchDragEvent', bytes: 1000 };
}

// ---------- runTab（inline 模式：artifact 全文注入 prompt） ----------
export async function runTab(cdp, page, reviewer, promptText, rawDir, shotDir) {
  return runTabBase(cdp, page, reviewer, promptText, rawDir, shotDir, { isUploadMode: false });
}

async function attachAndEnable(cdp, page, reviewer, log) {
  const attach = await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true });
  const sessionId = attach.sessionId;
  log.sessionId = sessionId;
  log.phase.push('attached');

  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  log.phase.push('enabled');

  return { sessionId };
}

async function navigateIfNeeded(cdp, sessionId, reviewer, log) {
  if (reviewer.skip_fresh_chat !== true) {
    const fresh = await navigateToFreshChat(cdp, sessionId, reviewer);
    log.fresh = fresh;
    if (fresh.ok) {
      log.phase.push('fresh-chat');
    } else {
      console.error('[FATAL] ' + reviewer.name + ' 新会话导航失败，中止分发: ' + fresh.error);
      throw new Error('fresh-chat failed: ' + reviewer.name);
    }
  } else {
    console.log('[LOG] ' + reviewer.name + ' 复用当前页面，跳过 fresh-chat 导航');
  }
}

async function injectPrompt(cdp, sessionId, promptText, log) {
  const injectR = await cdp.send('Runtime.evaluate', {
    expression: buildInjectScript(promptText),
    returnByValue: true,
  }, sessionId);
  log.inject = injectR.result.value;
  log.phase.push('injected');
}

async function submitForm(cdp, sessionId, reviewer, log) {
  const submitR = await cdp.send('Runtime.evaluate', {
    expression: buildSubmitScript(reviewer),
    returnByValue: true,
  }, sessionId);
  log.submit = submitR.result.value;
  log.phase.push('submitted');
  log.t_submit = Date.now();   // 计量：问题发出时刻（不含等待）
}

function computeResponseTimeout(reviewer, promptText) {
  // P2-14: 超时统一 —— inline 模式 artifact 全文在 promptText 里，按其字符量调整
  let responseMaxMs = reviewer.response_max_ms || TIMEOUT_INLINE_BASE_MS;
  const inlineCharsKB = (promptText || '').length / 1024;
  if (inlineCharsKB > TIMEOUT_ARTIFACT_UNIT_KB) {
    const factor = Math.pow(TIMEOUT_ARTIFACT_FACTOR, Math.ceil(inlineCharsKB / TIMEOUT_ARTIFACT_UNIT_KB));
    responseMaxMs = Math.min(responseMaxMs * factor, TIMEOUT_INLINE_MAX_MS);
  }
  return responseMaxMs;
}

async function checkAndRetrySubmit(cdp, sessionId, reviewer, log, responseMaxMs) {
  const stateR = await cdp.send('Runtime.evaluate', {
    expression: buildEditorStateScript(),
    returnByValue: true,
  }, sessionId);
  log.editorState = stateR.result.value;
  if (log.editorState && log.editorState.ok && log.editorState.containsMarker) {
    console.warn('[WARN] ' + reviewer.name + ' 提交后输入框仍含 prompt，重试提交一次');
    const submitR2 = await cdp.send('Runtime.evaluate', {
      expression: buildSubmitScript(reviewer),
      returnByValue: true,
    }, sessionId);
    log.submitRetry = submitR2.result.value;
    await new Promise(r => setTimeout(r, 1500));
    const stateR2 = await cdp.send('Runtime.evaluate', {
      expression: buildEditorStateScript(),
      returnByValue: true,
    }, sessionId);
    log.editorStateRetry = stateR2.result.value;
    if (log.editorStateRetry && log.editorStateRetry.ok && log.editorStateRetry.containsMarker) {
      // R-05: 大 prompt（inline 模式 100KB+）提交后，Gemini 清空编辑器 + 跳转对话页
      // 需要数秒；marker 残留不代表提交失败。降级前先检测响应活动迹象：
      // URL 已跳转到 /app/<id>、或已有 model-response 节点、或正在生成。
      // 有任一迹象 → 保留完整超时。
      const actR = await cdp.send('Runtime.evaluate', {
        expression: `(() => ({
          navigated: /\\/app\\/[A-Za-z0-9]{6,}/.test(location.pathname),
          hasResponse: !!document.querySelector('model-response, model-response-content, [data-message-author-role="assistant"], .markdown'),
          generating: !![...document.querySelectorAll('button')].find(b => {
            const t = ((b.innerText||'') + ' ' + (b.getAttribute('aria-label')||'')).toLowerCase();
            return /stop|停止|cancel|取消生成/.test(t) && b.offsetParent !== null;
          }),
        }))()`,
        returnByValue: true,
      }, sessionId);
      const act = actR.result && actR.result.value;
      log.responseActivity = act;
      if (act && (act.navigated || act.hasResponse || act.generating)) {
        console.warn('[WARN] ' + reviewer.name + ' marker 残留但检测到响应活动（nav=' + act.navigated + ' resp=' + act.hasResponse + ' gen=' + act.generating + '），保留完整超时');
      } else {
        console.warn('[WARN] ' + reviewer.name + ' submit 可能失败（输入框未清空且无响应活动），等待上限降至 60s');
        responseMaxMs = 60000;
      }
    }
  }
  return responseMaxMs;
}

async function captureScreenshot(cdp, sessionId, shotDir, reviewer, log) {
  const png = join(shotDir, reviewer.name + '.png');
  try {
    const shot = await screenshotTab(cdp, sessionId, png);
    log.screenshot = { path: png, ...shot };
    log.phase.push('screenshot');
  } catch (e) {
    log.screenshot = { path: png, error: e.message };
  }
}

async function saveResponseMarkdown(rawDir, reviewer, finalSnap, log) {
  const mdPath = join(rawDir, reviewer.name + '.md');
  writeFileSync(mdPath,
    '# ' + reviewer.name + '\n\n' +
    'URL: ' + finalSnap.url + '\n' +
    'Title: ' + finalSnap.title + '\n\n' +
    '## Response\n\n' + finalSnap.lastText + '\n',
    'utf8');
  log.mdPath = mdPath;
}


// 把 reviewer 运行日志落盘，便于诊断 upload/submit/snapshot 失败
// P2-10: 日志静默修复 — 诊断日志失败应告警而非静默吞掉
function dumpReviewerLog(log, rawDir) {
  try {
    writeFileSync(join(rawDir, log.name + '-log.json'), JSON.stringify(log, null, 2), 'utf8');
  } catch (e) {
    console.warn('[LOG]', log.name + '-log.json write failed:', e.message);
  }
}

async function runTabBase(cdp, page, reviewer, promptText, rawDir, shotDir, options = {}) {
   const {
     isUploadMode = false,
     artifactAbsPath = null,
     uploadCallback = null,
     postSubmitCallback = null,
     qualityGateCallback = null,
     maxRegen = 1
   } = options;
   
   const log = { name: reviewer.name, phase: [] };
  const sessionId = await attachToTarget(cdp, page);
   log.sessionId = sessionId;
   log.phase.push('attached');

   await cdp.send('Page.enable', {}, sessionId);
   await cdp.send('Runtime.enable', {}, sessionId);
   log.phase.push('enabled');

   // 会话隔离：同上，上传前先导航到新会话页，清空上一轮上下文。
   // skip_fresh_chat: true 时复用当前页面（用户已手动选模型级别），跳过导航。
   if (reviewer.skip_fresh_chat !== true) {
     const fresh = await navigateToFreshChat(cdp, sessionId, reviewer);
     log.fresh = fresh;
     if (fresh.ok) {
       log.phase.push('fresh-chat');
     } else {
       console.error('[FATAL] ' + reviewer.name + ' 新会话导航失败，中止分发: ' + fresh.error);
       throw new Error('fresh-chat failed: ' + reviewer.name);
     }
   } else {
     console.log('[LOG] ' + reviewer.name + ' 复用当前页面，跳过 fresh-chat 导航');
   }

   // Handle upload if in upload mode
   if (isUploadMode && uploadCallback) {
     try {
       const uploadResult = await uploadCallback(cdp, sessionId, reviewer, artifactAbsPath);
       log.upload = uploadResult;
       log.phase.push('uploaded');
     } catch (e) {
       log.upload = { error: e.message };
       log.phase.push('upload-failed');
       log.error = 'UPLOAD_FAILED: ' + e.message;
        // 不继续注入 prompt；返回失败态（ok: false，调用方据此判定）
        const mdPath = join(rawDir, reviewer.name + '.md');
        await fsPromises.writeFile(mdPath,
          '# ' + reviewer.name + '\n\n' +
          'URL: (upload failed)\n' +
          'Title: (upload failed)\n\n' +
          '## Response\n\n' +
          'UPLOAD_FAILED: ' + e.message + '\n',
          'utf8');
       log.mdPath = mdPath;
       log.ok = false;
       dumpReviewerLog(log, rawDir);
       return log;
     }
   }

   const injectR = await cdp.send('Runtime.evaluate', {
     expression: buildInjectScript(promptText),
     returnByValue: true,
   }, sessionId);
   log.inject = injectR.result.value;
   log.phase.push('injected');

   await new Promise(r => setTimeout(r, 800));

   const submitR = await cdp.send('Runtime.evaluate', {
     expression: buildSubmitScript(reviewer),
     returnByValue: true,
   }, sessionId);
   log.submit = submitR.result.value;
   log.phase.push('submitted');
  log.t_submit = Date.now();   // 计量：问题发出时刻（不含等待）
   
   // Handle post-submit logic if provided
   if (postSubmitCallback) {
     await postSubmitCallback(cdp, sessionId, reviewer, log);
   }

   // Determine response timeout based on mode
   let responseMaxMs;
    if (isUploadMode) {
      // P2-14: upload 路径超时统一
      let upMaxMs = reviewer.response_max_ms || TIMEOUT_UPLOAD_BASE_MS;
      const artifactStats = artifactAbsPath ? await fsPromises.stat(artifactAbsPath) : null;
      const artifactSizeKB = artifactStats ? artifactStats.size / 1024 : 0;
      if (artifactSizeKB > TIMEOUT_ARTIFACT_UNIT_KB) {
        const factor = Math.pow(TIMEOUT_ARTIFACT_FACTOR, Math.ceil(artifactSizeKB / TIMEOUT_ARTIFACT_UNIT_KB));
        upMaxMs = Math.min(upMaxMs * factor, TIMEOUT_UPLOAD_MAX_MS);
      }
      responseMaxMs = upMaxMs;
    } else {
     // P2-14: 超时统一 —— inline 模式 artifact 全文在 promptText 里，按其字符量调整
     responseMaxMs = reviewer.response_max_ms || TIMEOUT_INLINE_BASE_MS;
     const inlineCharsKB = (promptText || '').length / 1024;
     if (inlineCharsKB > TIMEOUT_ARTIFACT_UNIT_KB) {
       const factor = Math.pow(TIMEOUT_ARTIFACT_FACTOR, Math.ceil(inlineCharsKB / TIMEOUT_ARTIFACT_UNIT_KB));
       responseMaxMs = Math.min(responseMaxMs * factor, TIMEOUT_INLINE_MAX_MS);
     }
   }

   await new Promise(r => setTimeout(r, 1500));
   const stateR = await cdp.send('Runtime.evaluate', {
     expression: buildEditorStateScript(),
     returnByValue: true,
   }, sessionId);
   log.editorState = stateR.result.value;
   if (log.editorState && log.editorState.ok && log.editorState.containsMarker) {
     console.warn('[WARN] ' + reviewer.name + ' 提交后输入框仍含 prompt，重试提交一次');
     const submitR2 = await cdp.send('Runtime.evaluate', {
       expression: buildSubmitScript(reviewer),
       returnByValue: true,
     }, sessionId);
     log.submitRetry = submitR2.result.value;
     await new Promise(r => setTimeout(r, 1500));
     const stateR2 = await cdp.send('Runtime.evaluate', {
       expression: buildEditorStateScript(),
       returnByValue: true,
     }, sessionId);
     log.editorStateRetry = stateR2.result.value;
     if (log.editorStateRetry && log.editorStateRetry.ok && log.editorStateRetry.containsMarker) {
       // R-05: 大 prompt（inline 模式 100KB+）提交后，Gemini 清空编辑器 + 跳转对话页
       // 需要数秒；marker 残留不代表提交失败。降级前先检测响应活动迹象：
       // URL 已跳转到 /app/<id>、或已有 model-response 节点、或正在生成。
       // 有任一迹象 → 保留完整超时。
       const actR = await cdp.send('Runtime.evaluate', {
         expression: `(() => ({
           navigated: /\\/app\\/[A-Za-z0-9]{6,}/.test(location.pathname),
           hasResponse: !!document.querySelector('model-response, model-response-content, [data-message-author-role="assistant"], .markdown'),
           generating: !![...document.querySelectorAll('button')].find(b => {
             const t = ((b.innerText||'') + ' ' + (b.getAttribute('aria-label')||'')).toLowerCase();
             return /stop|停止|cancel|取消生成/.test(t) && b.offsetParent !== null;
           }),
         }))()`,
         returnByValue: true,
       }, sessionId);
       const act = actR.result && actR.result.value;
       log.responseActivity = act;
       if (act && (act.navigated || act.hasResponse || act.generating)) {
         console.warn('[WARN] ' + reviewer.name + ' marker 残留但检测到响应活动（nav=' + act.navigated + ' resp=' + act.hasResponse + ' gen=' + act.generating + '），保留完整超时');
       } else {
         console.warn('[WARN] ' + reviewer.name + ' submit 可能失败（输入框未清空且无响应活动），等待上限降至 60s');
         responseMaxMs = 60000;
       }
     }
   }

   let finalSnap;
   try {
     finalSnap = await waitForResponse(cdp, sessionId, { maxMs: responseMaxMs, stableMs: isUploadMode ? RESPONSE_STABLE_UPLOAD_MS : RESPONSE_STABLE_DEFAULT_MS, extraSelectors: reviewer && reviewer.response_selector });
     log.phase.push('responded');
     log.t_response = Date.now();   // 计量：回复捕获时刻
   } catch (e) {
     log.phase.push('response-timeout');
     log.t_timeout = Date.now();   // 计量：等回复超时时刻
     // 快照可能同样失败（页面导航/session 失效/序列化异常）：
     // 兜底合成最小快照，保证 raw md 与后续 analyze/architect 链路不崩，并保留原始错误。
     let snapR = null;
     try {
       snapR = await cdp.send('Runtime.evaluate', {
         expression: buildSnapshotScript(reviewer && reviewer.response_selector),
         returnByValue: true,
       }, sessionId);
     } catch (e2) {
       log.snapshotError = 'evaluate-threw: ' + e2.message;
     }
     finalSnap = snapR && snapR.result && snapR.result.value;
     if (!finalSnap) {
       if (snapR && snapR.result && snapR.result.exceptionDetails) {
         log.snapshotError = 'exception: ' + JSON.stringify(snapR.result.exceptionDetails.exception?.description || snapR.result.exceptionDetails.text).slice(0, 500);
       }
       finalSnap = {
         url: '(snapshot-failed)', title: '(snapshot-failed)', readyState: '',
         bodyLen: 0, lastText: '', lastTextLen: 0,
         bodyTail: '', realTail: '', realTailLen: 0,
         afterMarker: '', afterMarkerLen: 0, generating: false,
         _snapshotFailed: true, _snapshotError: log.snapshotError || 'no-result-value',
       };
     }
     log.error = e.message;
     // T-62（2026-10-14）：超时全文兜底——两通道全瞎时抓 body.innerText 全文落 raw md，不落空壳。
     if (!finalSnap._snapshotFailed && (finalSnap.lastTextLen || 0) === 0 && (finalSnap.afterMarkerLen || 0) <= 50 && (finalSnap.realTailLen || 0) <= 50) {
       try {
         const fullR = await cdp.send('Runtime.evaluate', {
           expression: '(() => { const t = document.body ? (document.body.innerText || "") : ""; return t.length > ' + MAX_REPORT_CHARS + ' ? t.slice(0, ' + MAX_REPORT_CHARS + ') : t; })()',
           returnByValue: true,
         }, sessionId);
         const fullText = fullR && fullR.result && fullR.result.value;
         if (typeof fullText === 'string' && fullText.trim().length > 0) {
           finalSnap.lastText = '[CAPTURE-FALLBACK body.innerText 全文兜底（T-62）]\n' + fullText;
           finalSnap.lastTextLen = fullText.length;
           finalSnap.fallback = 'BODY_INNERTEXT_FULL';
           log.bodyFallback = { len: fullText.length };
           console.warn('[WARN] ' + reviewer.name + ' 响应超时：body.innerText 全文兜底（' + fullText.length + ' chars）替代空壳');
         }
       } catch (e3) { log.bodyFallback = { error: e3.message }; }
     }
   }
   log.snapshot = finalSnap;

   // Handle weak response quality gate and auto-refresh if provided (upload mode only)
   if (isUploadMode && qualityGateCallback) {
     // 弱回复质量门 + 自动点刷新（T-40 用户反馈：grok 回复无意义、chatgpt 回复空 [] 都要点 ⟳；
     // 4 页均有"刷新"选项）。gate 判定回复不可用 → 悬停后点 regenerate → 等旧文本变化 → 等稳定；
     // 找不到刷新按钮则同页重发 prompt 兜底。最多 maxRegen 次；任何失败保留原回复，不阻塞主链。
     if (qualityGateCallback) {
        log.regen = [];
        for (let gi = 0; gi < maxRegen; gi++) {
          const curText = (finalSnap && finalSnap.lastText) || '';
          if (!qualityGateCallback(curText)) break;
          // T-71 复现修复（2026-10-21 实测 scan-mvh8vnmh → scan-mvha0zta 两轮）：
          // 弱回复的根因不是「模型没给 findings」，而是「页面根本没渲染完」——
          // deepseek 首轮 waitForResponse 超时 → T-62 兜底只抓到 61 字符空壳；
          // gemini 合法回 `[]`（= 无问题）也是短文本。短文本一律不判弱：
          // 既避免同页重发产生重复气泡，也避免把合法短回复当故障重试。
          // 判据不依赖 generating 标志（停止按钮文案检测在 deepseek/grok 上不可靠，
          // 实测 generating=false 但正文仍在生成）。
          if ((curText || '').trim().length < 200) {
            console.warn('[WARN] ' + reviewer.name + ' 捕获文本过短（' + (curText || '').trim().length + ' 字符，判定页面未渲染完/合法空回复），跳过 regen/重发');
            log.regen.push({ skipped: 'short-text', len: (curText || '').trim().length });
            break;
          }
          // T-71 复现修复（2026-10-21 实测 scan-mvh8vnmh/deepseek）：首轮 waitForResponse
          // 超时 → T-62 兜底只抓到 61 字符（页面仍在生成、正文未渲染完）→ 弱闸误判 →
          // 找不到刷新按钮 → 同页重发 prompt → 同一页两条用户气泡 = 重复气泡。
          // 生成态门：判弱后重抓快照，若页面仍在生成（generating）或文本仍在增长，
          // 则不 regen（不重发），改为继续等回复到稳。
          let genSnap = null;
          try {
            const gR = await cdp.send('Runtime.evaluate', { expression: buildSnapshotScript(reviewer && reviewer.response_selector), returnByValue: true }, sessionId);
            genSnap = gR.result && gR.result.value;
          } catch { /* 快照失败按原逻辑继续 */ }
          const curLen = (curText || '').length;
          const newLen = (genSnap && (genSnap.lastTextLen || 0)) || 0;
          if (genSnap && (genSnap.generating || newLen > curLen)) {
            console.warn('[WARN] ' + reviewer.name + ' 页面仍在生成（generating=' + !!genSnap.generating + '，文本 ' + curLen + '→' + newLen + ' 字符），跳过 regen/重发，改为继续等回复');
            log.regen.push({ skipped: 'generating-state', generating: !!genSnap.generating, textLenFrom: curLen, textLenTo: newLen });
            try {
              const waitMs = Math.min(reviewer.response_max_ms || 120000, 180000);
              finalSnap = await waitForResponse(cdp, sessionId, { maxMs: waitMs, stableMs: 5000, extraSelectors: reviewer && reviewer.response_selector });
              log.phase.push('regen-responded');
            } catch (e) {
              log.regen.push({ ok: false, reason: 'generating-wait-timeout', error: e.message });
            }
            break;
          }
          console.warn('[WARN] ' + reviewer.name + ' 回复过弱（无有效 findings），点刷新重生成 (' + (gi + 1) + ')');
         // 先悬停最后一条回复：chatgpt 等站点消息工具栏 hover 才渲染
         try {
           const posR = await cdp.send('Runtime.evaluate', {
             expression: `(() => {
               const msgs = [...document.querySelectorAll('[data-message-author-role="assistant"], model-response, .markdown, article, .message-bubble')];
               const last = msgs[msgs.length - 1];
               if (!last) return null;
               const r = last.getBoundingClientRect();
               return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
             })()`,
             returnByValue: true,
           }, sessionId);
           const pos = posR.result && posR.result.value;
           if (pos && pos.x > 0) {
             await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none', buttons: 0 }, sessionId);
             await new Promise(r => setTimeout(r, 600));
           }
         } catch { /* 悬停失败不阻塞，直接尝试点击 */ }
         let clickVal = null;
         try {
           const clickR = await cdp.send('Runtime.evaluate', { expression: buildRegenClickScript(reviewer?.regen_selector), returnByValue: true }, sessionId);
           clickVal = clickR.result && clickR.result.value;
         } catch (e) {
           clickVal = { ok: false, error: e.message };
         }
         log.regen.push(clickVal || { ok: false });
          if (!clickVal || !clickVal.ok) {
            // 刷新按钮按会话状态条件渲染 → 确定性兜底：同页重发一次 prompt
            //（复用注入+提交+升级确认，走已验证的发送路径）
            // T-71 复现修复（2026-10-21）：同页重发 = 同页第二条用户气泡 = 重复气泡根源。
            // 重发前必须再判一次生成态：页面仍在生成（首轮 response-timeout 兜底抓到
            // 61 字符空壳时的典型状态）→ 不重发，改为继续等回复到稳。
            let stillGenerating = false;
            try {
              const g2 = await cdp.send('Runtime.evaluate', { expression: buildSnapshotScript(reviewer && reviewer.response_selector), returnByValue: true }, sessionId);
              const g2v = g2.result && g2.result.value;
              stillGenerating = !!(g2v && g2v.generating);
            } catch { /* 探测失败按不生成处理 */ }
            if (stillGenerating) {
              console.warn('[WARN] ' + reviewer.name + ' 页面仍在生成，跳过同页重发（防重复气泡）');
              log.regen.push({ skipped: 'resend-blocked-generating' });
              try {
                const waitMs2 = Math.min(reviewer.response_max_ms || 120000, 180000);
                finalSnap = await waitForResponse(cdp, sessionId, { maxMs: waitMs2, stableMs: 5000, extraSelectors: reviewer && reviewer.response_selector });
                log.phase.push('regen-responded');
              } catch (e) {
                log.regen.push({ ok: false, reason: 'generating-wait-timeout', error: e.message });
              }
              break;
            }
            console.warn('[WARN] ' + reviewer.name + ' 未找到刷新按钮，同页重发 prompt 兜底');
           try {
             const injR = await cdp.send('Runtime.evaluate', { expression: buildInjectScript(promptText), returnByValue: true }, sessionId);
             await new Promise(r => setTimeout(r, 800));
             const subR = await cdp.send('Runtime.evaluate', { expression: buildSubmitScript(reviewer), returnByValue: true }, sessionId);
             await new Promise(r => setTimeout(r, 1500));
             const stR = await cdp.send('Runtime.evaluate', { expression: buildEditorStateScript(), returnByValue: true }, sessionId);
             const st = stR.result && stR.result.value;
             if (st && st.ok && st.textLen > 0) {
               const altMode2 = reviewer.submit_method === 'enter' ? 'button' : 'enter';
               await cdp.send('Runtime.evaluate', { expression: buildSubmitScript(reviewer, altMode2), returnByValue: true }, sessionId);
               await new Promise(r => setTimeout(r, 1500));
             }
             log.regen.push({
               method: 'resend',
               inject: injR.result && injR.result.value,
               submit: subR.result && subR.result.value,
               editorCleared: !(st && st.ok && st.textLen > 0),
             });
           } catch (e) {
             log.regen.push({ method: 'resend', error: e.message });
             break;
           }
         }
         // 等新回复真正开始：文本与旧回复不同 或 出现 generating 迹象，最多 20s
         const changeDeadline = Date.now() + 20000;
         let changed = false;
         while (Date.now() < changeDeadline) {
           try {
             const sR = await cdp.send('Runtime.evaluate', { expression: buildSnapshotScript(reviewer && reviewer.response_selector), returnByValue: true }, sessionId);
             const sVal = sR.result && sR.result.value;
             if (sVal && (((sVal.lastText || '') !== curText) || sVal.generating)) { changed = true; break; }
           } catch { /* 页面重渲染中 */ }
           await new Promise(r => setTimeout(r, 1000));
         }
         if (!changed) {
           log.regen.push({ ok: false, reason: 'no-change-timeout' });
           console.warn('[WARN] ' + reviewer.name + ' 刷新/重发后 20s 内无新内容，保留原回复');
           break;
         }
         try {
           const rgMax = Math.min(reviewer.response_max_ms || 120000, 180000);
           finalSnap = await waitForResponse(cdp, sessionId, { maxMs: rgMax, stableMs: 5000, extraSelectors: reviewer && reviewer.response_selector });
           log.phase.push('regen-responded');
         } catch (e) {
           log.regen.push({ ok: false, reason: 'regen-timeout', error: e.message });
           break;
         }
       }
       log.snapshot = finalSnap;
     }
   }

   const png = join(shotDir, reviewer.name + '.png');
   try {
     const shot = await screenshotTab(cdp, sessionId, png);
     log.screenshot = { path: png, ...shot };
     log.phase.push('screenshot');
   } catch (e) {
     log.screenshot = { path: png, error: e.message };
   }

    const mdPath = join(rawDir, reviewer.name + '.md');
    if (isUploadMode) {
      await fsPromises.writeFile(mdPath,
        '# ' + reviewer.name + '\n\n' +
        'URL: ' + finalSnap.url + '\n' +
        'Title: ' + finalSnap.title + '\n' +
        'Delivery: upload\n\n' +
        '## Response\n\n' + finalSnap.lastText + '\n',
        'utf8');
    } else {
      await fsPromises.writeFile(mdPath,
        '# ' + reviewer.name + '\n\n' +
        'URL: ' + finalSnap.url + '\n' +
        'Title: ' + finalSnap.title + '\n\n' +
        '## Response\n\n' + finalSnap.lastText + '\n',
        'utf8');
    }
   log.mdPath = mdPath;

   dumpReviewerLog(log, rawDir);
   return log;
 }

// ---------- runTabUpload（upload 模式：文件走附件通道，prompt 只写短指令） ----------
export async function runTabUpload(cdp, page, reviewer, artifactAbsPath, promptText, rawDir, shotDir, opts = {}) {
   return runTabBase(cdp, page, reviewer, promptText, rawDir, shotDir, {
     isUploadMode: true,
     artifactAbsPath: artifactAbsPath,
     uploadCallback: async (cdp, sessionId, reviewer, artifactAbsPath) => {
       return await uploadFileToTab(cdp, sessionId, reviewer, artifactAbsPath);
     },
     postSubmitCallback: async (cdp, sessionId, reviewer, log) => {
       // 提交确认 + 换方式升级重试（T-40 实测：deepseek attempt-1 按钮点中了但被吞、
       // chatgpt 附件态合成 Enter 不发送而蓝色发送按钮是亮的——1.5s 后输入框仍有内容
       // 就换另一种提交方式再试一次，正对应用户反馈"没点发送就该点发送按钮"）。
       await new Promise(r => setTimeout(r, 1500));
       try {
         const stateR = await cdp.send('Runtime.evaluate', {
           expression: buildEditorStateScript(),
           returnByValue: true,
         }, sessionId);
         log.editorState = stateR.result.value;
         if (log.editorState && log.editorState.ok && log.editorState.textLen > 0) {
           const altMode = reviewer.submit_method === 'enter' ? 'button' : 'enter';
           console.warn('[WARN] ' + reviewer.name + ' 附件提交后输入框未清空（textLen=' +
             log.editorState.textLen + '），换方式重试提交: ' + altMode);
           const altR = await cdp.send('Runtime.evaluate', {
             expression: buildSubmitScript(reviewer, altMode),
             returnByValue: true,
           }, sessionId);
           log.submitAlt = altR.result.value;
           log.phase.push('submit-alt');
           await new Promise(r => setTimeout(r, 1500));
         }
       } catch (e) {
         log.submitConfirmError = e.message;
       }

       // 提交后等待"消息真正发出"：输入框残余 prompt 被清空 且 URL 已从初始页跳到会话页。
       // 通用判定（不维护站点正则表）：URL 与 url_open 初始值不同即发生跳转。
       //   Gemini: / → /app/<id>；DeepSeek: / → /a/chat/s/<id>；Grok: / → /c/<id>
        const initialUrlNorm = String(reviewer.url_open || '').split('?')[0].replace(/\/+$/, '');
        const sendCheckExpr = buildSendCheckExpr(initialUrlNorm, Boolean(reviewer.url_open));
       // T-48 救援点击：附件态下首次提交常被"附件仍在处理（send 按钮 aria-disabled）"挡住——
       // 旧逻辑 30s 观察窗只看不救，消息永远停在输入框（chatgpt 164KB 附件实测复现）。
       // 窗内每 ~5s 探一次：输入框仍有残余且发送按钮已就绪 → 补点；残余清空即不再点（防双发）。
       const sendRescueExpr = `(() => {
          const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
            .filter(e => e.offsetParent !== null)
            .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
          const residual = el ? (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || '')) : '';
          const len = residual.replace(/[\\s\\u200b]/g, '').replace(/<br\\s*\\/?>/g, '').length;
          if (len === 0) return { clicked: false, reason: 'empty' };
          const btn = document.querySelector('button[data-testid="send-button"]')
            || [...document.querySelectorAll('button, [role="button"]')].filter(b => {
                const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
                return /send|发送|submit/.test(t);
              })[0];
          if (!btn) return { clicked: false, reason: 'no-btn', residualLen: len };
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { clicked: false, reason: 'disabled', residualLen: len };
          btn.click();
          return { clicked: true, residualLen: len };
        })()`;
        const sendDeadline = Date.now() + 15000;
       let sentOk = false;
       let rescueTries = 0;
       let lastRescueAt = 0;
       while (Date.now() < sendDeadline) {
         try {
           const sc = await cdp.send('Runtime.evaluate', { expression: sendCheckExpr, returnByValue: true }, sessionId);
           if (sc.result.value && sc.result.value.sent) { sentOk = true; break; }
           const resid = sc.result.value ? sc.result.value.residualLen : -1;
           if (resid > 0 && rescueTries < 4 && Date.now() - lastRescueAt > 5000) {
             rescueTries++;
             lastRescueAt = Date.now();
             try {
               const rr = await cdp.send('Runtime.evaluate', { expression: sendRescueExpr, returnByValue: true }, sessionId);
               const rv = rr.result && rr.result.value;
               (log.sendRescue = log.sendRescue || []).push(rv || { error: 'no-value' });
               if (rv && rv.clicked) console.warn('[WARN] ' + reviewer.name + ' send-rescue 补点发送按钮 (try ' + rescueTries + ')');
             } catch (e) {
               (log.sendRescue = log.sendRescue || []).push({ error: e.message });
             }
           }
         } catch { /* 页面跳转中，evaluate 可能短暂失败，重试 */ }
         await new Promise(r => setTimeout(r, 1000));
       }
        log.sent = { ok: sentOk };
        if (!sentOk) console.warn('[WARN] ' + reviewer.name + ' 提交后 15s 内未确认消息发出（可能仍在排队）');
     },
     qualityGateCallback: (curText) => {
       return opts && typeof opts.regenGate === 'function' ? opts.regenGate(curText) : false;
     },
     maxRegen: opts?.maxRegen || 1
   });
 }
