import { COMMUNICATION_DISPLAY_VERSION } from './version.js'
import { devicesMarkup, devicesScript } from './management-devices.js'
import { managementCSS } from './management-style.js'
import { directoryMarkup, directoryScript, directoryCSS } from './management-directory.js'

export const managementPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DS-Bot Hub</title>
<style>${managementCSS}${directoryCSS}</style>
<main><header class="hub-header"><span class="hub-mark" aria-hidden="true">↔</span><h1>DS-Bot Hub</h1><span class="hub-version" aria-label="Hub 版本">${COMMUNICATION_DISPLAY_VERSION}</span></header><p class="intro">设置新设备的加入方式，并向设备所有者核实身份。设备名称未经身份验证。</p><section id="login"><h2>管理员登录</h2><form id="sign-in" method="post" action="/admin/login" autocomplete="on"><label>用户名 <input name="username" value="admin" autocomplete="username" readonly></label><label>密码 <input id="password" name="password" type="password" autocomplete="current-password" placeholder="管理员密码" required></label><button type="submit">登录</button></form><p>浏览器可通过密码管理器记住密码；DS-Bot 不会将密码保存在浏览器存储中。请只访问可信的 HTTPS 地址。</p></section><p id="error" role="status"></p><div id="content" hidden><p id="live-status" role="status"></p><button id="logout">退出登录</button><button id="revoke-sessions">退出所有登录会话</button>${devicesMarkup}${directoryMarkup}<section class="hub-code"><h2>Hub 码</h2><p id="hub-code-status" role="status"></p><button id="copy-code" type="button" disabled>复制 Hub 码</button><details><summary>查看 Hub 码与信任详情</summary><p>请只通过可信渠道分享此码。V2 码包含绑定到此 Hub 的公开 CA 信任信息，不要接受来源未经验证的 Hub 码。新设备按下方设置的规则加入。</p><code id="code"></code></details></section><section class="device-requests"><label class="admission-control"><input id="auto-approve" type="checkbox"> 允许新设备直接加入，无需批准</label><p id="admission-status" role="status"></p><p>开启后，持有此 Hub 码并通过设备密钥验证的新设备会自动加入。已有待处理申请仍需批准或拒绝。联系人和 Bot 的权限独立管理。</p><details id="device-requests-detail"><summary>设备申请 <span id="request-count"></span></summary><div id="requests"></div></details></section></div><dialog id="join-delete-dialog" aria-labelledby="join-delete-title"><h2 id="join-delete-title">彻底删除申请</h2><p id="join-delete-target"></p><p>直接从 Hub 删除已保存的申请，无需联系申请方。客户端也可独立撤销失效的申请。</p><p id="join-delete-error" role="alert"></p><button id="join-delete-cancel" type="button">取消</button><button id="join-delete-submit" type="button" class="danger">删除申请</button></dialog></main><script src="/admin/app.js" defer></script></html>`
export const managementScript = `
let deletingJoin;
let admissionPolicy = {autoApprove:false,version:1}, admissionSaving = false;
let csrf, revision = '', refreshFlight, refreshAgain = false, watchTimer, watchController, watchEpoch = 0, failures = 0;
const $ = id => document.getElementById(id);
async function api(action, input = {}, signal) {
  const r = await fetch('/admin/api/' + action, {method:'POST', credentials:'same-origin',
    headers:{'content-type':'application/json', ...(csrf ? {'x-csrf-token':csrf} : {})},
    body:JSON.stringify(input), signal: signal ?? AbortSignal.timeout(15000)});
  const value = await r.json();
  if (!r.ok || !value.ok) throw Error(value.error?.code || 'REQUEST_FAILED');
  return value;
}
function managementError(e) {
  const code = e.message, labels = {UNAUTHENTICATED:'登录已失效，请重新登录',FORBIDDEN:'没有执行此操作的权限',RATE_LIMITED:'操作过于频繁，请稍后重试',REQUEST_FAILED:'请求失败，请检查连接后重试',INVALID_REQUEST:'请求内容无效',ENROLLMENT_POLICY_VERSION_CONFLICT:'加入规则已变化，请查看最新设置后重试',JOIN_NOT_FOUND:'申请已不存在，请查看最新状态',INSTANCE_NOT_FOUND:'设备已不存在，请查看最新状态'};
  if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return (labels[code] ?? '操作失败，请刷新状态后重试') + ' [' + code + ']';
  return /[\u4e00-\u9fff]/.test(code) ? code : '请求失败，请检查连接后重试';
}
function error(e) {
  const message = e.message === 'STATIC_PEER_REMOVAL_REQUIRED' ? '该设备由 Hub 启动配置中的 peers 声明。请先从配置中移除对应实例 ID 并重启 Hub，再彻底删除。' : e.message === 'DEVICE_DELETE_VERSION_CONFLICT' ? '设备身份已变化，请关闭弹窗并核对最新详情后再确认。' : e.message === 'DEVICE_DELETE_GROUPS_CHANGED' ? '该设备拥有的群组已变化，当前状态会自动更新。请重新核对删除范围；本次未删除数据。' : e.message === 'INSTANCE_NAME_VERSION_CONFLICT' ? '设备名称已在其他位置修改，当前状态会自动更新。请核对后重新编辑。' : managementError(e);
  $('error').textContent = message;
  if ($('device-confirm').open) $('device-confirm-error').textContent = message;
  else if ($('device-dialog').open) $('device-error').textContent = message;
}
function text(tag, value) { const e = document.createElement(tag); e.textContent = value; return e; }
function button(label, run) {
  const b = text('button', label);
  b.onclick = async () => { b.disabled = true; $('error').textContent = ''; try { await run(); await refresh(); } catch(e) { error(e); } finally { b.disabled = false; } };
  return b;
}
function renameForm(instance) {
  const form = document.createElement('form'), label = text('label', '实例名称'), input = document.createElement('input'), save = text('button', '保存名称');
  form.className = 'instance-name-form'; input.value = instance.label; input.required = true; input.maxLength = 100;
  input.setAttribute('aria-label', '实例名称（' + instance.instanceId + '）'); save.type = 'submit'; label.append(input); form.append(label, save);
  form.onsubmit = async event => {
    event.preventDefault(); if (save.disabled) return; save.disabled = true; input.disabled = true; $('error').textContent = ''; $('device-error').textContent = '';
    try { await api('rename', {instanceId:instance.instanceId, label:input.value, expectedNameVersion:instance.nameVersion}); form.dataset.saved = 'true'; await refresh(); }
    catch(e) { error(e); } finally { save.disabled = false; input.disabled = false; }
  };
  return form;
}
${directoryScript}
${devicesScript}
$('auto-approve').onchange = async () => {
  const checkbox = $('auto-approve'), autoApprove = checkbox.checked;
  admissionSaving = true; checkbox.disabled = true; $('error').textContent = '';
  try { admissionPolicy = (await api('enrollment-policy', {autoApprove,expectedVersion:admissionPolicy.version})).value; }
  catch(e) { error(e); }
  finally { admissionSaving = false; checkbox.disabled = false; checkbox.checked = admissionPolicy.autoApprove; }
  try { await refresh(); } catch(e) { error(e); }
};
function showJoinDelete(request) {
  deletingJoin = {...request}; $('join-delete-target').textContent = request.label+' · '+request.requestId;
  $('join-delete-error').textContent=''; $('join-delete-submit').disabled=false;
  openDeviceDialog($('join-delete-dialog')); $('join-delete-cancel').focus();
}
$('join-delete-cancel').onclick=()=>{deletingJoin=undefined;closeDeviceDialog($('join-delete-dialog'));};
$('join-delete-submit').onclick=async()=>{
  const request=deletingJoin;if(!request||$('join-delete-submit').disabled)return;
  $('join-delete-submit').disabled=true;
  try{
    await api('delete-join',{requestId:request.requestId,expectedVersion:request.version,confirmDelete:true});
    deletingJoin=undefined;closeDeviceDialog($('join-delete-dialog'));await refresh();
  }catch(e){$('join-delete-error').textContent=['JOIN_VERSION_CONFLICT','JOIN_HAS_DEVICE'].includes(e.message)?'申请已变化或已获批准。请查看最新状态；如需移除已加入的设备，请使用“管理已批准的设备”。':managementError(e);try{await refresh();}catch{} }
  finally{$('join-delete-submit').disabled=false;}
};
function render(value) {
  if(deletingJoin&&!value.requests.some(item=>item.requestId===deletingJoin.requestId)){
    deletingJoin=undefined;closeDeviceDialog($('join-delete-dialog'));
  }
  if (!admissionSaving) {
    admissionPolicy = value.enrollmentPolicy ?? {autoApprove:false,version:1};
    $('auto-approve').checked = admissionPolicy.autoApprove;
    $('admission-status').textContent = admissionPolicy.autoApprove ? '新设备申请将自动通过。' : '新设备申请需要管理员批准。';
  }
  updateDirectory(value.participants ?? []);
  const code = typeof value.code === 'string' && value.code.startsWith('dsbot-hub:2:') ? value.code : '';
  $('hub-code-status').textContent = value.codeError || value.code && !code ? 'HUB_V2_MIGRATION_REQUIRED：请在 management.pairingCaFile 配置公开 CA，并使用匹配的 WSS 证书，然后重启 Hub。重置数据不会启用 V2。' : code ? 'V2 Hub 码，已包含公开 CA。' : '尚未配置 Hub 地址。';
  $('code').textContent = code || '暂无可用的 V2 Hub 码。'; $('copy-code').disabled = !code;
  const requests = new Map([...$('requests').children].map(row => [row.dataset.requestId, row]));
  const requestRows = value.requests.map(r => {
    let row = requests.get(r.requestId);
    const signature = JSON.stringify(r);
    if (!row || row.dataset.signature !== signature) {
      row = document.createElement('article'); row.dataset.requestId = r.requestId; row.dataset.signature = signature;
      row.append(text('strong', r.label + ' — ' + ({pending:'待审批',approved:'已批准',rejected:'已拒绝',cancelled:'已撤销',expired:'已过期'}[r.status] ?? r.status)), text('small', '指纹：' + r.fingerprint));
      if (r.status === 'pending') for (const action of ['approve', 'reject']) row.append(button(action === 'approve' ? '批准' : '拒绝', () => api('decide', {requestId:r.requestId, expectedVersion:r.version, action})));
      if(r.instanceId&&(value.instances??[]).some(i=>i.instanceId===r.instanceId)) row.append(button('管理已批准的设备',()=>showDeviceDetails(r.instanceId)));
      else row.append(button('删除申请',()=>showJoinDelete(r)));
    }
    return row;
  });
  reconcile($('requests'), requestRows, '暂无申请记录。');
  updateDevices(value.instances ?? [],value.participants ?? []);
  $('request-count').textContent = '（'+(value.requests ?? []).filter(r => r.status === 'pending').length+' 项待处理）';
}
function reconcile(container, rows, empty) {
  const desired = new Set(rows);
  for (const node of [...container.children]) if (!desired.has(node)) node.remove();
  rows.forEach((row, index) => { if (container.children[index] !== row) container.insertBefore(row, container.children[index] ?? null); });
  if (!rows.length && !container.children.length) container.append(text('p', empty));
}
function refresh() {
  if (refreshFlight) { refreshAgain = true; return refreshFlight; }
  refreshFlight = (async () => {
    do {
      refreshAgain = false;
      const result = await api('state');
      if (!refreshAgain && csrf) { revision = result.revision ?? ''; render(result.value); $('live-status').textContent = '状态已实时更新。'; }
    } while (refreshAgain && csrf);
  })().finally(() => { refreshFlight = null; });
  return refreshFlight;
}
function pause() { watchEpoch += 1; clearTimeout(watchTimer); watchController?.abort(); watchController = null; }
function resume() {
  pause(); if (!csrf || document.visibilityState === 'hidden') return;
  const epoch = watchEpoch;
  const watch = async () => {
    let delay = 100;
    try {
      await refresh(); if (epoch !== watchEpoch || !csrf) return;
      watchController = new AbortController(); const controller = watchController, deadline = setTimeout(() => controller.abort(), 25000);
      try { await api('changes', {revision}, controller.signal); } finally { clearTimeout(deadline); }
      failures = 0;
    } catch(e) {
      if (epoch !== watchEpoch) return;
      if (e.message === 'UNAUTHENTICATED') { csrf = undefined; deviceConfirmation = undefined; closeDeviceDialog($('device-confirm')); closeDeviceDetails(); $('content').hidden = true; $('login').hidden = false; error(Error('请重新登录以查看 Hub 最新状态。')); return; }
      $('live-status').textContent = '状态可能已过期，正在重新连接… ' + (/^[A-Z][A-Z0-9_]{0,63}$/.test(e.message) ? '[' + e.message + ']' : '无法读取 Hub 状态。');
      for (const node of document.querySelectorAll('.instance-connection,.directory-connection')) node.textContent = '连接状态未知';
      for (const node of document.querySelectorAll('.directory-presence')) node.dataset.connected = 'unknown';
      delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + Math.random() * 0.4);
    }
    if (epoch === watchEpoch && csrf && document.visibilityState !== 'hidden') watchTimer = setTimeout(watch, delay);
  };
  void watch();
}
$('copy-code').onclick = async () => { try { await navigator.clipboard.writeText($('code').textContent); $('error').textContent = 'Hub 码已复制，请只通过可信渠道分享。'; } catch { $('error').textContent = '浏览器无法自动复制，请展开 Hub 码后手动复制。'; } };
$('logout').onclick = async () => { pause(); try { await api('logout'); } finally { csrf = undefined; location.reload(); } };
$('revoke-sessions').onclick = async () => { pause(); try { await api('sessions/revoke'); } finally { csrf = undefined; location.reload(); } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pause(); else resume(); });
window.addEventListener('online', resume); window.addEventListener('focus', resume); window.addEventListener('pagehide', pause);
api('session').then(result => { csrf = result.csrf; $('login').hidden = true; $('content').hidden = false; resume(); }).catch(() => {});
`;
