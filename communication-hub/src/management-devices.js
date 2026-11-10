export const devicesMarkup = `<section class="hub-devices" aria-labelledby="devices-title"><div class="directory-heading"><h2 id="devices-title">Devices</h2><span id="device-count" class="directory-count"></span></div><div class="device-tools"><label>Find a device<input id="device-search" type="search" placeholder="Name, person or instance ID" autocomplete="off"></label><label>Status<select id="device-filter"><option value="all">All devices</option><option value="online">Connected</option><option value="offline">Disconnected</option><option value="revoked">Revoked</option></select></label></div><div id="instances" role="list" aria-label="Devices"></div><div class="device-pages"><button id="device-previous" type="button">Previous</button><span id="device-page" role="status"></span><button id="device-next" type="button">Next</button></div></section><dialog id="device-dialog" aria-labelledby="device-title"><header><h2 id="device-title">Device details</h2><button id="device-close" type="button" aria-label="Close device details">Close</button></header><p id="device-error" role="alert"></p><div id="device-details"></div></dialog><dialog id="device-confirm" aria-labelledby="device-confirm-title"><header><h2 id="device-confirm-title"></h2><button id="device-confirm-close" type="button" aria-label="Cancel device action">Cancel</button></header><div id="device-confirm-body"></div><p id="device-confirm-error" role="alert"></p><footer><button id="device-confirm-cancel" type="button">Cancel</button><button id="device-confirm-submit" type="button"></button></footer></dialog>`

export const devicesScript = `
let deviceRows = [], devicePeople = [], devicePage = 0, selectedDevice, devicePanelSignature, deviceReturnFocus, deviceConfirmation;
const deviceStamp = i => JSON.stringify([i.instanceId,i.pairingRevision,i.nameVersion,i.revision,i.trusted,(i.ownedSharedGroups ?? []).map(g => [g.conversationId,g.version]).sort()]);
function deviceControl(label,run) { const control = text('button',label); control.type = 'button'; control.onclick = run; return control; }
function openDeviceDialog(dialog) { if (dialog.open) return; if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open',''); }
function closeDeviceDialog(dialog) { if (typeof dialog.close === 'function') dialog.close(); else { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')); } }
function closeDeviceDetails() { closeDeviceDialog($('device-dialog')); selectedDevice = undefined; devicePanelSignature = undefined; deviceReturnFocus?.focus(); }
function cancelDeviceAction() { if (deviceConfirmation?.busy) return; deviceConfirmation = undefined; closeDeviceDialog($('device-confirm')); }
function showDeviceAction(instance, action) {
  const i = JSON.parse(JSON.stringify(instance)), groups = i.ownedSharedGroups ?? [];
  deviceConfirmation = {instance:i,action,stamp:deviceStamp(i),busy:false};
  const deleting = action === 'delete';
  $('device-confirm-title').textContent = deleting ? 'Delete device permanently' : action === 'revoke' ? 'Revoke access' : 'Repair original device';
  $('device-confirm-submit').textContent = deleting ? 'Delete permanently' : action === 'revoke' ? 'Revoke access' : 'Restore same-key trust';
  $('device-confirm-submit').disabled = false; $('device-confirm-submit').className = action === 'repair' ? '' : 'danger';
  $('device-confirm-error').textContent = '';
  const body = $('device-confirm-body'); body.replaceChildren(text('strong',i.label),text('code',i.instanceId));
  body.append(text('p',deleting ? 'This cannot be undone. Remove this device, its Human and Bots, contacts, private chats and device-only groups from this Hub. Other devices and shared history are retained. A reset client does not need to approve this administrator action.' : action === 'revoke' ? 'Stop this device’s access, group memberships and pending deliveries. Its identity and history remain available for explicit same-key repair.' : 'Restore trust only for the previously proved key. A reset client with a new key must enroll as a new device. Group memberships stay removed.'));
  if (deleting) {
    body.append(text('p',groups.length ? 'These owned shared groups will be closed without assigning a new owner:' : 'No shared groups will be closed.'));
    for (const group of groups) { const item = text('p',group.title); item.append(text('code',group.conversationId)); body.append(item); }
  }
  openDeviceDialog($('device-confirm')); $('device-confirm-cancel').focus();
}
function showDeviceDetails(id, source) {
  $('device-error').textContent = ''; selectedDevice = id; deviceReturnFocus = source; devicePanelSignature = undefined; renderDeviceDetails(); openDeviceDialog($('device-dialog'));
}
function renderDeviceDetails() {
  if (!selectedDevice) return;
  const i = deviceRows.find(item => item.instanceId === selectedDevice);
  if (!i) { if (!$('device-confirm').open) closeDeviceDetails(); return; }
  if (devicePanelSignature === JSON.stringify(i)) return;
  const pane = $('device-details'), old = pane.querySelector('form'), input = old?.querySelector('input'), focused = old?.contains(document.activeElement) ? document.activeElement : null, position = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart,focused.selectionEnd] : null;
  const retain = old && old.dataset.saved !== 'true' && (input.disabled || input.value !== old.dataset.base || old.contains(document.activeElement));
  const form = retain ? old : renameForm(i); if (!retain) form.dataset.base = i.label;
  $('device-title').textContent = i.label;
  const connection = text('p',i.connected === true ? 'Connected to Hub' : i.connected === false ? 'Disconnected from Hub' : 'Connection status unavailable'); connection.className = 'instance-connection';
  const id = text('code',i.instanceId); id.className = 'device-full-id';
  pane.replaceChildren(connection,text('p',i.trusted ? 'Access approved' : 'Access revoked'),text('label','Instance ID'),id,form);
  const people = devicePeople.filter(p => p.homeInstanceId === i.instanceId);
  pane.append(text('p',people.filter(p => p.kind === 'human').map(p => p.displayName).join(', ') || 'No Human profile'));
  const bots = people.filter(p => p.kind === 'bot'); pane.append(text('h3','Published Bots ('+bots.length+')'));
  for (const bot of bots) pane.append(text('p',bot.displayName+' · '+(bot.publicProfile?.headline || 'Bot')));
  const actions = document.createElement('div'); actions.className = 'device-actions';
  if (i.trusted) actions.append(deviceControl('Revoke access',()=>showDeviceAction(i,'revoke')));
  actions.append(deviceControl('Delete device permanently',()=>showDeviceAction(i,'delete')));
  if (!i.trusted && i.revision) actions.append(deviceControl('Repair original device',()=>showDeviceAction(i,'repair')));
  pane.append(actions); if (retain && focused?.isConnected) { focused.focus({preventScroll:true}); if (position) focused.setSelectionRange(...position); } devicePanelSignature = JSON.stringify(i);
}
function renderDevices() {
  const query = $('device-search').value.trim().toLowerCase(), filter = $('device-filter').value;
  const rows = deviceRows.filter(i => (filter === 'all' || filter === 'revoked' && !i.trusted || filter === 'online' && i.connected === true || filter === 'offline' && i.connected === false)
    && (!query || [i.label,i.instanceId,...devicePeople.filter(p => p.homeInstanceId === i.instanceId).map(p => p.displayName)].join(' ').toLowerCase().includes(query)));
  const pages = Math.max(1,Math.ceil(rows.length/25)); devicePage = Math.min(devicePage,pages-1);
  $('device-count').textContent = rows.length+' / '+deviceRows.length+' devices · '+deviceRows.filter(i => i.connected === true).length+' connected';
  $('device-page').textContent = 'Page '+(devicePage+1)+' / '+pages;
  $('device-previous').disabled = devicePage === 0; $('device-next').disabled = devicePage >= pages-1;
  const existing = new Map([...$('instances').children].map(row => [row.dataset.instanceId,row]));
  const visible = rows.slice(devicePage*25,devicePage*25+25).map(i => {
    let row = existing.get(i.instanceId);
    if (!row) {
      row = document.createElement('article'); row.className = 'device-row'; row.dataset.instanceId = i.instanceId; row.setAttribute('role','listitem');
      const copy = document.createElement('div'); copy.className = 'device-copy'; copy.append(text('strong',''),text('small',''));
      const health = document.createElement('div'); health.className = 'device-health';
      const connection = text('span',''); connection.className = 'instance-connection'; health.append(connection,text('span',''));
      const manage = deviceControl('Manage',()=>showDeviceDetails(i.instanceId,manage)); manage.className = 'device-manage';
      row.append(copy,health,manage);
    }
    row.querySelector('strong').textContent = i.label;
    const people = devicePeople.filter(p => p.homeInstanceId === i.instanceId), bots = people.filter(p => p.kind === 'bot'), owners = people.filter(p => p.kind === 'human' && p.displayName !== i.label);
    const meta = row.querySelector('small'); meta.textContent = i.instanceId.slice(0,12)+' · '+bots.length+' Bots'+(owners.length ? ' · '+owners.map(p => p.displayName).join(', ') : ''); meta.title = i.instanceId;
    row.querySelector('.instance-connection').textContent = i.connected === true ? 'Connected to Hub' : i.connected === false ? 'Disconnected from Hub' : 'Connection status unavailable';
    row.querySelector('.device-health').lastChild.textContent = i.trusted ? 'Approved' : 'Revoked';
    row.querySelector('button').setAttribute('aria-label','Manage '+i.label+' ('+i.instanceId+')');
    return row;
  });
  reconcile($('instances'),visible,deviceRows.length ? 'No matching devices.' : 'No enrolled devices.');
  renderDeviceDetails();
  if (deviceConfirmation && !deviceConfirmation.busy) {
    const current = deviceRows.find(i => i.instanceId === deviceConfirmation.instance.instanceId);
    if (!current || deviceStamp(current) !== deviceConfirmation.stamp) {
      $('device-confirm-error').textContent = 'Device or owned groups changed. Cancel and review current details before confirming.';
      $('device-confirm-submit').disabled = true;
    }
  }
}
function updateDevices(instances, participants) { deviceRows = [...instances].sort((a,b) => Number(b.connected === true)-Number(a.connected === true) || a.label.localeCompare(b.label) || a.instanceId.localeCompare(b.instanceId)); devicePeople = participants; renderDevices(); }
$('device-search').oninput = $('device-filter').onchange = () => { devicePage = 0; renderDevices(); };
$('device-previous').onclick = () => { devicePage--; renderDevices(); };
$('device-next').onclick = () => { devicePage++; renderDevices(); };
$('device-close').onclick = closeDeviceDetails;
$('device-dialog').addEventListener('cancel',event => { event.preventDefault(); closeDeviceDetails(); });
$('device-confirm-close').onclick = $('device-confirm-cancel').onclick = cancelDeviceAction;
$('device-confirm').addEventListener('cancel',event => { event.preventDefault(); cancelDeviceAction(); });
$('device-confirm-submit').onclick = async () => {
  const confirm = deviceConfirmation; if (!confirm || confirm.busy || $('device-confirm-submit').disabled) return;
  confirm.busy = true; $('device-confirm-submit').disabled = true;
  const i = confirm.instance;
  try {
    const input = confirm.action === 'delete' ? {instanceId:i.instanceId,expectedPairingRevision:i.pairingRevision,expectedNameVersion:i.nameVersion,ownedSharedGroups:(i.ownedSharedGroups ?? []).map(g => ({conversationId:g.conversationId,version:g.version})),confirmDelete:true} : confirm.action === 'repair' ? {instanceId:i.instanceId,expectedRevision:i.revision} : {instanceId:i.instanceId};
    await api(confirm.action,input); deviceConfirmation = undefined; closeDeviceDialog($('device-confirm')); await refresh();
    if (confirm.action === 'delete') closeDeviceDetails();
  } catch (e) { $('device-confirm-error').textContent = e.message; error(e); }
  finally { if (deviceConfirmation === confirm) { confirm.busy = false; $('device-confirm-submit').disabled = true; $('device-confirm-error').textContent += ' Close and review current state before trying again.'; } }
};
`
