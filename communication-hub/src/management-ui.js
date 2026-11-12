import { COMMUNICATION_VERSION } from './version.js'
import { devicesMarkup, devicesScript } from './management-devices.js'
import { managementCSS } from './management-style.js'
import { directoryMarkup, directoryScript, directoryCSS } from './management-directory.js'

export const managementPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DS-Bot Hub</title>
<style>${managementCSS}${directoryCSS}</style>
<main><header class="hub-header"><span class="hub-mark" aria-hidden="true">↔</span><h1>DS-Bot Hub</h1><span class="hub-version" aria-label="Hub version">V${COMMUNICATION_VERSION}</span></header><p class="intro">Choose how new devices join and review their identity with their owners. Device names are unverified.</p><section id="login"><h2>Administrator sign in</h2><form id="sign-in" method="post" action="/admin/login" autocomplete="on"><label>Username <input name="username" value="admin" autocomplete="username" readonly></label><label>Password <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Administrator password" required></label><button type="submit">Sign in</button></form><p>Your browser can remember this password in its password manager. DS-Bot does not save it in browser storage. Use only a trusted HTTPS address.</p></section><p id="error" role="status"></p><div id="content" hidden><p id="live-status" role="status"></p><button id="logout">Sign out</button><button id="revoke-sessions">Sign out all sessions</button>${devicesMarkup}${directoryMarkup}<section class="hub-code"><h2>Hub code</h2><p id="hub-code-status" role="status"></p><button id="copy-code" type="button" disabled>Copy Hub code</button><details><summary>Show code and trust details</summary><p>Give this code only through a trusted channel. A v2 code includes public CA trust bound to this Hub; do not accept a code from an unverified connection. New devices follow the admission policy below.</p><code id="code"></code></details></section><section class="device-requests"><label class="admission-control"><input id="auto-approve" type="checkbox"> Allow new devices to join without approval</label><p id="admission-status" role="status"></p><p>When enabled, devices with this Hub code and a valid device-key proof join automatically. Existing pending requests still need a decision. Contact and Bot permissions remain separate.</p><details id="device-requests-detail"><summary>Device requests <span id="request-count"></span></summary><div id="requests"></div></details></section></div><dialog id="join-delete-dialog" aria-labelledby="join-delete-title"><h2 id="join-delete-title">Delete application permanently</h2><p id="join-delete-target"></p><p>This removes the saved application from this Hub without contacting the applicant. Its client can withdraw the orphaned application independently.</p><p id="join-delete-error" role="alert"></p><button id="join-delete-cancel" type="button">Cancel</button><button id="join-delete-submit" type="button" class="danger">Delete application</button></dialog></main><script src="/admin/app.js" defer></script></html>`
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
function error(e) {
  const message = e.message === 'STATIC_PEER_REMOVAL_REQUIRED' ? 'This device is declared in the Hub startup peers configuration. Remove its exact instance ID from that configuration and restart the Hub before permanent deletion.' : e.message === 'DEVICE_DELETE_VERSION_CONFLICT' ? 'Device identity changed. Close this dialog and review its current details before confirming again.' : e.message === 'DEVICE_DELETE_GROUPS_CHANGED' ? 'Owned groups changed. Current status updates automatically; review the deletion again. No data was deleted.' : e.message === 'INSTANCE_NAME_VERSION_CONFLICT' ? 'Device name changed elsewhere. Current status updates automatically; review it before editing again.' : e.message;
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
  const form = document.createElement('form'), label = text('label', 'Instance name'), input = document.createElement('input'), save = text('button', 'Save name');
  form.className = 'instance-name-form'; input.value = instance.label; input.required = true; input.maxLength = 100;
  input.setAttribute('aria-label', 'Instance name (' + instance.instanceId + ')'); save.type = 'submit'; label.append(input); form.append(label, save);
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
  }catch(e){$('join-delete-error').textContent=['JOIN_VERSION_CONFLICT','JOIN_HAS_DEVICE'].includes(e.message)?'This application changed or was approved. Review its current state; use Manage approved device to remove an existing device.':e.message;try{await refresh();}catch{} }
  finally{$('join-delete-submit').disabled=false;}
};
function render(value) {
  if(deletingJoin&&!value.requests.some(item=>item.requestId===deletingJoin.requestId)){
    deletingJoin=undefined;closeDeviceDialog($('join-delete-dialog'));
  }
  if (!admissionSaving) {
    admissionPolicy = value.enrollmentPolicy ?? {autoApprove:false,version:1};
    $('auto-approve').checked = admissionPolicy.autoApprove;
    $('admission-status').textContent = admissionPolicy.autoApprove ? 'New device requests are approved automatically.' : 'New device requests require administrator approval.';
  }
  updateDirectory(value.participants ?? []);
  const code = typeof value.code === 'string' && value.code.startsWith('dsbot-hub:2:') ? value.code : '';
  $('hub-code-status').textContent = value.codeError || value.code && !code ? 'HUB_V2_MIGRATION_REQUIRED: Configure management.pairingCaFile with the public CA and a matching WSS certificate, then restart the Hub. Resetting data does not enable v2.' : code ? 'v2 pairing code — public CA included.' : 'Hub address is not configured.';
  $('code').textContent = code || 'No v2 Hub code available.'; $('copy-code').disabled = !code;
  const requests = new Map([...$('requests').children].map(row => [row.dataset.requestId, row]));
  const requestRows = value.requests.map(r => {
    let row = requests.get(r.requestId);
    const signature = JSON.stringify(r);
    if (!row || row.dataset.signature !== signature) {
      row = document.createElement('article'); row.dataset.requestId = r.requestId; row.dataset.signature = signature;
      row.append(text('strong', r.label + ' — ' + r.status), text('small', 'Fingerprint: ' + r.fingerprint));
      if (r.status === 'pending') for (const action of ['approve', 'reject']) row.append(button(action, () => api('decide', {requestId:r.requestId, expectedVersion:r.version, action})));
      if(r.instanceId&&(value.instances??[]).some(i=>i.instanceId===r.instanceId)) row.append(button('Manage approved device',()=>showDeviceDetails(r.instanceId)));
      else row.append(button('Delete application',()=>showJoinDelete(r)));
    }
    return row;
  });
  reconcile($('requests'), requestRows, 'No pending requests.');
  updateDevices(value.instances ?? [],value.participants ?? []);
  $('request-count').textContent = '('+(value.requests ?? []).filter(r => r.status === 'pending').length+' pending)';
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
      if (!refreshAgain && csrf) { revision = result.revision ?? ''; render(result.value); $('live-status').textContent = 'Status is up to date.'; }
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
      if (e.message === 'UNAUTHENTICATED') { csrf = undefined; deviceConfirmation = undefined; closeDeviceDialog($('device-confirm')); closeDeviceDetails(); $('content').hidden = true; $('login').hidden = false; error(Error('Sign in again to see current Hub status.')); return; }
      $('live-status').textContent = 'Status may be out of date. Reconnecting… ' + (/^[A-Z][A-Z0-9_]{0,63}$/.test(e.message) ? '[' + e.message + ']' : 'Could not read Hub status.');
      for (const node of document.querySelectorAll('.instance-connection,.directory-connection')) node.textContent = 'Connection status unavailable';
      for (const node of document.querySelectorAll('.directory-presence')) node.dataset.connected = 'unknown';
      delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + Math.random() * 0.4);
    }
    if (epoch === watchEpoch && csrf && document.visibilityState !== 'hidden') watchTimer = setTimeout(watch, delay);
  };
  void watch();
}
$('copy-code').onclick = async () => { try { await navigator.clipboard.writeText($('code').textContent); $('error').textContent = 'Hub code copied. Share it only through a trusted channel.'; } catch { $('error').textContent = 'Copy is unavailable in this browser. Expand the code and copy it manually.'; } };
$('logout').onclick = async () => { pause(); try { await api('logout'); } finally { csrf = undefined; location.reload(); } };
$('revoke-sessions').onclick = async () => { pause(); try { await api('sessions/revoke'); } finally { csrf = undefined; location.reload(); } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pause(); else resume(); });
window.addEventListener('online', resume); window.addEventListener('focus', resume); window.addEventListener('pagehide', pause);
api('session').then(result => { csrf = result.csrf; $('login').hidden = true; $('content').hidden = false; resume(); }).catch(() => {});
`;
