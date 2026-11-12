export const devicesMarkup = `<section class="hub-devices" aria-labelledby="devices-title"><div class="directory-heading"><h2 id="devices-title">设备</h2><span id="device-count" class="directory-count"></span></div><div class="device-tools"><label>查找设备<input id="device-search" type="search" placeholder="名称、用户或实例 ID" autocomplete="off"></label><label>状态<select id="device-filter"><option value="all">全部设备</option><option value="online">已连接</option><option value="offline">未连接</option><option value="revoked">已撤销</option></select></label></div><div id="instances" role="list" aria-label="设备"></div><div class="device-pages"><button id="device-previous" type="button">上一页</button><span id="device-page" role="status"></span><button id="device-next" type="button">下一页</button></div></section><dialog id="device-dialog" aria-labelledby="device-title"><header><h2 id="device-title">设备详情</h2><button id="device-close" type="button" aria-label="关闭设备详情">关闭</button></header><p id="device-error" role="alert"></p><div id="device-details"></div></dialog><dialog id="device-confirm" aria-labelledby="device-confirm-title"><header><h2 id="device-confirm-title"></h2><button id="device-confirm-close" type="button" aria-label="取消设备操作">取消</button></header><div id="device-confirm-body"></div><p id="device-confirm-error" role="alert"></p><footer><button id="device-confirm-cancel" type="button">取消</button><button id="device-confirm-submit" type="button"></button></footer></dialog>`

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
  $('device-confirm-title').textContent = deleting ? '彻底删除设备' : action === 'revoke' ? '撤销访问权限' : '恢复原设备信任';
  $('device-confirm-submit').textContent = deleting ? '彻底删除' : action === 'revoke' ? '撤销访问权限' : '恢复原密钥信任';
  $('device-confirm-submit').disabled = false; $('device-confirm-submit').className = action === 'repair' ? '' : 'danger';
  $('device-confirm-error').textContent = '';
  const body = $('device-confirm-body'); body.replaceChildren(text('strong',i.label),text('code',i.instanceId));
  body.append(text('p',deleting ? '此操作不可撤销。将从 Hub 删除该设备及其用户、Bot、联系人、私聊和仅属于该设备的群组；保留其他设备与共享聊天记录。管理员可直接删除，无需已重置的客户端确认。' : action === 'revoke' ? '停止该设备的访问、群成员资格与待投递消息。身份和历史仍保留，后续可使用原密钥明确恢复信任。' : '只恢复已验证过的原密钥信任。重置后使用新密钥的客户端须作为新设备申请加入。此操作不会恢复群成员资格。'));
  if (deleting) {
    body.append(text('p',groups.length ? '以下由该设备拥有的共享群将被解散，不会自动转让群主：' : '不会解散任何共享群。'));
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
  const connection = text('p',i.connected === true ? '已连接 Hub' : i.connected === false ? '未连接 Hub' : '连接状态未知'); connection.className = 'instance-connection';
  const id = text('code',i.instanceId); id.className = 'device-full-id';
  pane.replaceChildren(connection,text('p',i.trusted ? '访问已批准' : '访问已撤销'),text('label','实例 ID'),id,form);
  const people = devicePeople.filter(p => p.homeInstanceId === i.instanceId);
  pane.append(text('p',people.filter(p => p.kind === 'human').map(p => p.displayName).join(', ') || '暂无用户资料'));
  const bots = people.filter(p => p.kind === 'bot'); pane.append(text('h3','已发布的 Bot（'+bots.length+'）'));
  for (const bot of bots) pane.append(text('p',bot.displayName+' · '+(bot.publicProfile?.headline || 'Bot')));
  const actions = document.createElement('div'); actions.className = 'device-actions';
  if (i.trusted) actions.append(deviceControl('撤销访问权限',()=>showDeviceAction(i,'revoke')));
  actions.append(deviceControl('彻底删除设备',()=>showDeviceAction(i,'delete')));
  if (!i.trusted && i.revision) actions.append(deviceControl('恢复原设备信任',()=>showDeviceAction(i,'repair')));
  pane.append(actions); if (retain && focused?.isConnected) { focused.focus({preventScroll:true}); if (position) focused.setSelectionRange(...position); } devicePanelSignature = JSON.stringify(i);
}
function renderDevices() {
  const query = $('device-search').value.trim().toLowerCase(), filter = $('device-filter').value;
  const rows = deviceRows.filter(i => (filter === 'all' || filter === 'revoked' && !i.trusted || filter === 'online' && i.connected === true || filter === 'offline' && i.connected === false)
    && (!query || [i.label,i.instanceId,...devicePeople.filter(p => p.homeInstanceId === i.instanceId).map(p => p.displayName)].join(' ').toLowerCase().includes(query)));
  const pages = Math.max(1,Math.ceil(rows.length/25)); devicePage = Math.min(devicePage,pages-1);
  $('device-count').textContent = rows.length+' / '+deviceRows.length+' 台设备 · '+deviceRows.filter(i => i.connected === true).length+' 台已连接';
  $('device-page').textContent = '页码 '+(devicePage+1)+' / '+pages;
  $('device-previous').disabled = devicePage === 0; $('device-next').disabled = devicePage >= pages-1;
  const existing = new Map([...$('instances').children].map(row => [row.dataset.instanceId,row]));
  const visible = rows.slice(devicePage*25,devicePage*25+25).map(i => {
    let row = existing.get(i.instanceId);
    if (!row) {
      row = document.createElement('article'); row.className = 'device-row'; row.dataset.instanceId = i.instanceId; row.setAttribute('role','listitem');
      const copy = document.createElement('div'); copy.className = 'device-copy'; copy.append(text('strong',''),text('small',''));
      const health = document.createElement('div'); health.className = 'device-health';
      const connection = text('span',''); connection.className = 'instance-connection'; health.append(connection,text('span',''));
      const manage = deviceControl('管理',()=>showDeviceDetails(i.instanceId,manage)); manage.className = 'device-manage';
      row.append(copy,health,manage);
    }
    row.querySelector('strong').textContent = i.label;
    const people = devicePeople.filter(p => p.homeInstanceId === i.instanceId), bots = people.filter(p => p.kind === 'bot'), owners = people.filter(p => p.kind === 'human' && p.displayName !== i.label);
    const meta = row.querySelector('small'); meta.textContent = i.instanceId.slice(0,12)+' · '+bots.length+' 个 Bot'+(owners.length ? ' · '+owners.map(p => p.displayName).join(', ') : ''); meta.title = i.instanceId;
    row.querySelector('.instance-connection').textContent = i.connected === true ? '已连接 Hub' : i.connected === false ? '未连接 Hub' : '连接状态未知';
    row.querySelector('.device-health').lastChild.textContent = i.trusted ? '已批准' : '已撤销';
    row.querySelector('button').setAttribute('aria-label','管理 '+i.label+' ('+i.instanceId+')');
    return row;
  });
  reconcile($('instances'),visible,deviceRows.length ? '没有匹配的设备。' : '暂无已加入的设备。');
  renderDeviceDetails();
  if (deviceConfirmation && !deviceConfirmation.busy) {
    const current = deviceRows.find(i => i.instanceId === deviceConfirmation.instance.instanceId);
    if(!current){deviceConfirmation=undefined;closeDeviceDialog($('device-confirm'));closeDeviceDetails();$('error').textContent='该设备已不存在，Hub 中的记录已清理。';return;}
    if (deviceStamp(current) !== deviceConfirmation.stamp) {
      $('device-confirm-error').textContent = '设备或其拥有的群组已变化，请取消后查看最新详情再确认。';
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
  } catch (e) { $('device-confirm-error').textContent = managementError(e); error(e); }
  finally { if (deviceConfirmation === confirm) { confirm.busy = false; $('device-confirm-submit').disabled = true; $('device-confirm-error').textContent += ' 请关闭并查看最新状态后重试。'; } }
};
`
