import { managementCSS } from './management-style.js'

export const managementPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DS-Bot Hub</title>
<style>${managementCSS}</style>
<main><header class="hub-header"><span class="hub-mark" aria-hidden="true">↔</span><h1>DS-Bot Hub</h1></header><p class="intro">Approve only devices whose fingerprint you have checked with their owner. Device names are unverified.</p><section id="login"><h2>Administrator sign in</h2><form id="sign-in" method="post" action="/admin/login" autocomplete="on"><label>Username <input name="username" value="admin" autocomplete="username" readonly></label><label>Password <input id="password" name="password" type="password" autocomplete="current-password" placeholder="Administrator password" required></label><button type="submit">Sign in</button></form><p>Your browser can remember this password in its password manager. DS-Bot does not save it in browser storage. Use only a trusted HTTPS address.</p></section><p id="error" role="status"></p><div id="content" hidden><p id="live-status" role="status"></p><button id="refresh">Refresh</button><button id="logout">Sign out</button><button id="revoke-sessions">Sign out all sessions</button><section class="hub-code"><h2>Hub code</h2><button id="copy-code" type="button" disabled>Copy Hub code</button><details><summary>Show code and trust details</summary><p>Give this code only through a trusted channel. A v2 code includes public CA trust bound to this Hub; do not accept a code from an unverified connection. New devices still need approval.</p><code id="code"></code></details></section><section><h2>Device requests</h2><div id="requests"></div></section><section><h2>Devices</h2><div id="instances"></div></section></div></main><script src="/admin/app.js" defer></script></html>`
export const managementScript = `
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
function error(e) { if (e.message === 'DEVICE_DELETE_GROUPS_CHANGED') { $('error').textContent = 'Owned groups changed. Refresh and review the deletion again. No data was deleted.'; return; } $('error').textContent = e.message === 'INSTANCE_NAME_VERSION_CONFLICT' ? 'Device name changed elsewhere. Refresh before editing again.' : e.message; }
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
    event.preventDefault(); if (save.disabled) return; save.disabled = true; input.disabled = true; $('error').textContent = '';
    try { await api('rename', {instanceId:instance.instanceId, label:input.value, expectedNameVersion:instance.nameVersion}); form.dataset.saved = 'true'; await refresh(); }
    catch(e) { error(e); } finally { save.disabled = false; input.disabled = false; }
  };
  return form;
}
function render(value) {
  $('code').textContent = value.code || 'Set the reachable WSS address in the Hub configuration.'; $('copy-code').disabled = !value.code;
  const requests = new Map([...$('requests').children].map(row => [row.dataset.requestId, row]));
  const requestRows = value.requests.map(r => {
    let row = requests.get(r.requestId);
    const signature = JSON.stringify(r);
    if (!row || row.dataset.signature !== signature) {
      row = document.createElement('article'); row.dataset.requestId = r.requestId; row.dataset.signature = signature;
      row.append(text('strong', r.label + ' — ' + r.status), text('small', 'Fingerprint: ' + r.fingerprint));
      if (r.status === 'pending') for (const action of ['approve', 'reject']) row.append(button(action, () => api('decide', {requestId:r.requestId, expectedVersion:r.version, action})));
    }
    return row;
  });
  reconcile($('requests'), requestRows, 'No pending requests.');
  const instances = new Map([...$('instances').children].map(row => [row.dataset.instanceId, row]));
  const instanceRows = value.instances.map(i => {
    let row = instances.get(i.instanceId);
    if (!row) { row = document.createElement('article'); row.dataset.instanceId = i.instanceId; }
    if (row.dataset.signature !== JSON.stringify(i)) {
      const oldForm = row.querySelector('form'), field = oldForm?.querySelector('input');
      // Keep in-flight or unsaved edits and their original optimistic version.
      const retain = oldForm && oldForm.dataset.saved !== 'true' && (field.disabled || field.value !== oldForm.dataset.base || oldForm.contains(document.activeElement));
      const form = retain ? oldForm : renameForm(i); if (!retain) form.dataset.base = i.label;
      const heading = i.label + ' — ' + (i.trusted ? 'approved' : 'revoked');
      if (retain) {
        row.querySelector('strong').textContent = heading;
        for (const child of [...row.children]) if (child.tagName === 'BUTTON') child.remove();
      } else {
        const connection = text('small', ''); connection.className = 'instance-connection';
        row.replaceChildren(text('strong', heading), text('small', i.instanceId), connection, form);
      }
      if (i.trusted) row.append(button('Revoke access', () => { if (confirm('Remove this device: revoke access, group memberships and pending deliveries; keep chat history. Owned groups retain the inactive owner until the same device is explicitly repaired. Continue?')) return api('revoke', {instanceId:i.instanceId}); }));
      row.append(button('Delete device permanently', () => { if (confirm('Permanently delete this device, user and Bots, contacts, private chats and device-only groups from this Hub? This cannot be undone. Other devices and shared-group history are kept. Owned shared groups listed below will be closed without assigning a new owner. The device must reset its local Hub data before requesting fresh access.' + (i.ownedSharedGroups.length ? '\\n\\nGroups to close:\\n' + i.ownedSharedGroups.map(group => group.title + ' (' + group.conversationId + ')').join('\\n') : '\\n\\nNo shared groups will be closed.'))) return api('delete', {instanceId:i.instanceId, expectedPairingRevision:i.pairingRevision, expectedNameVersion:i.nameVersion, ownedSharedGroups:i.ownedSharedGroups.map(group => ({conversationId:group.conversationId,version:group.version})), confirmDelete:true}); }));
      if (!i.trusted && i.revision) row.append(button('Repair original device', () => { if (confirm('Restore trust for the same previously proved device key? Group memberships stay removed.')) return api('repair', {instanceId:i.instanceId, expectedRevision:i.revision}); }));
      row.dataset.signature = JSON.stringify(i);
    }
    row.querySelector('.instance-connection').textContent = i.connected === true ? 'Connected to Hub' : i.connected === false ? 'Disconnected from Hub' : 'Connection status unavailable';
    return row;
  });
  reconcile($('instances'), instanceRows, 'No enrolled devices.');
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
      if (e.message === 'UNAUTHENTICATED') { csrf = undefined; $('content').hidden = true; $('login').hidden = false; error(Error('Sign in again to see current Hub status.')); return; }
      $('live-status').textContent = 'Status may be out of date. Reconnecting…';
      for (const node of document.querySelectorAll('.instance-connection')) node.textContent = 'Connection status unavailable';
      delay = Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + Math.random() * 0.4);
    }
    if (epoch === watchEpoch && csrf && document.visibilityState !== 'hidden') watchTimer = setTimeout(watch, delay);
  };
  void watch();
}
$('copy-code').onclick = async () => { try { await navigator.clipboard.writeText($('code').textContent); $('error').textContent = 'Hub code copied. Share it only through a trusted channel.'; } catch { $('error').textContent = 'Copy is unavailable in this browser. Expand the code and copy it manually.'; } };
$('refresh').onclick = () => { $('error').textContent = ''; void refresh().catch(error); };
$('logout').onclick = async () => { pause(); try { await api('logout'); } finally { csrf = undefined; location.reload(); } };
$('revoke-sessions').onclick = async () => { pause(); try { await api('sessions/revoke'); } finally { csrf = undefined; location.reload(); } };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') pause(); else resume(); });
window.addEventListener('online', resume); window.addEventListener('focus', resume); window.addEventListener('pagehide', pause);
api('session').then(result => { csrf = result.csrf; $('login').hidden = true; $('content').hidden = false; resume(); }).catch(() => {});
`;
