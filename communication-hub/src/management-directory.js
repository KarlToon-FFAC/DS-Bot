export const directoryMarkup = `<section class="hub-directory" aria-labelledby="directory-title"><div class="directory-heading"><div><h2 id="directory-title">Hub 通讯录</h2><p>查看此 Hub 的联系人与公开 Bot。</p></div><span id="directory-count" class="directory-count"></span></div><div class="directory-tools"><div class="directory-tabs" role="group" aria-label="通讯录视图"><button id="show-contacts" type="button" aria-pressed="true">联系人</button><button id="show-bots" type="button" aria-pressed="false">公开 Bot</button></div><label class="directory-search">查找联系人或 Bot<input id="directory-search" type="search" placeholder="姓名、职责或技能" autocomplete="off"></label></div><div class="directory-layout"><div id="directory-list" role="list" aria-label="Hub 成员"></div><aside id="directory-profile" aria-label="选中成员的资料"></aside></div></section>`

export const directoryScript = `
let directoryPeople = [], directoryKind = 'human', directorySelection;
const directoryImages = new Map(), directoryLoads = new Map();
function publicProfile(person) { return person.publicProfile ?? {}; }
function directoryConnection(person) { return person.connected === true ? '已连接 Hub' : person.connected === false ? '未连接 Hub' : '连接状态未知'; }
function directoryAvatar(person, large = false) {
  const node = document.createElement('span'); node.className = 'directory-avatar' + (large ? ' directory-avatar-large' : '');
  node.dataset.kind = person.kind; node.setAttribute('aria-hidden', 'true');
  const name = person.displayName || person.principalId;
  node.textContent = person.kind === 'bot' ? 'B' : [...name.trim()].slice(0, 2).join('').toUpperCase();
  const revision = person.avatar?.imageRevision;
  if (!revision) return node;
  const key = JSON.stringify([person.principalId, revision]);
  const show = image => {
    if (!csrf || !directoryPeople.some(p => p.principalId === person.principalId && p.avatar?.imageRevision === revision)) return;
    const img = document.createElement('img'); img.src = image; img.alt = ''; img.draggable = false; node.replaceChildren(img);
  };
  if (directoryImages.has(key)) { show(directoryImages.get(key)); return node; }
  if (!directoryLoads.has(key)) {
    const load = (async () => {
      let image = '', total, offset = 0;
      do {
        const result = (await api('avatar', {principalId:person.principalId, imageRevision:revision, offset})).value;
        if (result.principalId !== person.principalId || result.imageRevision !== revision || result.offset !== offset || typeof result.data !== 'string' || !Number.isSafeInteger(result.totalLength) || result.totalLength > 160000 || result.totalLength < 1 || result.data.length < 1 || (total !== undefined && total !== result.totalLength)) throw Error('AVATAR_UNAVAILABLE');
        total = result.totalLength; image += result.data; offset = image.length;
        if (offset > total) throw Error('AVATAR_UNAVAILABLE');
      } while (offset < total);
      if (!/^data:image\\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw Error('AVATAR_UNAVAILABLE');
      if (csrf && directoryPeople.some(p => p.principalId === person.principalId && p.avatar?.imageRevision === revision)) directoryImages.set(key, image);
      return image;
    })().finally(() => directoryLoads.delete(key));
    directoryLoads.set(key, load);
  }
  void directoryLoads.get(key).then(show).catch(() => {});
  return node;
}
function directoryTags(values) {
  const tags = document.createElement('div'); tags.className = 'directory-tags';
  for (const value of values ?? []) tags.append(text('span', value));
  return tags;
}
function directorySelect(person) {
  directorySelection = directorySelection === person.principalId ? undefined : person.principalId; directoryKind = person.kind;
  renderDirectory();
  [...document.querySelectorAll('[data-directory-id]')].find(node => node.dataset.directoryId === person.principalId)?.focus();
}
function directoryRow(person) {
  const row = document.createElement('div'); row.setAttribute('role', 'listitem');
  const control = document.createElement('button'); control.type = 'button'; control.className = 'directory-row'; control.dataset.directoryId = person.principalId;
  control.setAttribute('aria-pressed', String(person.principalId === directorySelection));
  control.setAttribute('aria-expanded', String(person.principalId === directorySelection)); control.setAttribute('aria-controls', 'directory-profile');
  const body = document.createElement('span'); body.className = 'directory-row-copy';
  body.append(text('strong', person.displayName || person.principalId), text('span', publicProfile(person).headline || (person.kind === 'bot' ? 'Bot' : '用户')));
  const unavailable = {MODEL_NOT_CONFIGURED:'未配置模型',MODEL_UNAVAILABLE:'模型不可用',MODEL_CREDENTIAL_MISSING:'未配置模型密钥'}[person.availabilityError]; if (person.connected && unavailable) body.append(text('small',unavailable));
  control.title = [person.displayName, publicProfile(person).headline, person.instanceLabel].filter(Boolean).join(' · ');
  const marker = text('span', ''); marker.className = 'directory-presence'; marker.dataset.connected = String(person.connected); marker.title = directoryConnection(person);
  const chevron = text('span', person.principalId === directorySelection ? '⌄' : '›'); chevron.className = 'directory-chevron'; chevron.setAttribute('aria-hidden','true');
  control.append(directoryAvatar(person), body, marker, chevron); control.onclick = () => directorySelect(person); row.append(control); return row;
}
function renderDirectoryProfile(person) {
  const pane = $('directory-profile');
  pane.hidden = !person; document.querySelector('.directory-layout').dataset.expanded = String(Boolean(person));
  if (!person) { pane.replaceChildren(); return; }
  const profile = publicProfile(person), header = document.createElement('div'); header.className = 'directory-profile-heading';
  const titles = document.createElement('div'); titles.append(text('h3', person.displayName || person.principalId), text('p', profile.headline || (person.kind === 'bot' ? 'Bot' : '用户')));
  header.append(directoryAvatar(person, true), titles);
  const connection = text('p', directoryConnection(person)); connection.className = 'directory-connection';
  const about = text('p', profile.summary || '暂无简介。'); about.className = 'directory-about';
  pane.replaceChildren(header, connection, about);
  if (profile.expertise?.length) { pane.append(text('h4', person.kind === 'bot' ? '技能' : '职责与专长'), directoryTags(profile.expertise)); }
  if (person.kind === 'human') {
    const bots = directoryPeople.filter(p => p.kind === 'bot' && p.ownerPrincipalId === person.principalId);
    pane.append(text('h4', '已发布的 Bot'));
    if (!bots.length) pane.append(text('p', '暂无已发布的 Bot。'));
    for (const bot of bots) {
      const item = directoryRow(bot); item.className = 'directory-owned-bot'; pane.append(item);
    }
  } else {
    const owner = directoryPeople.find(p => p.principalId === person.ownerPrincipalId);
    if (owner) { const owned = text('p', '所属联系人：' + owner.displayName); owned.className = 'directory-source'; pane.append(owned); }
  }
  const details = document.createElement('details'); details.className = 'directory-identity'; details.append(text('summary', '身份详情'), text('code', person.principalId));
  if (person.instanceLabel || person.homeInstanceId) details.append(text('p', person.instanceLabel || person.homeInstanceId));
  pane.append(details);
}
function renderDirectory() {
  const focused = document.activeElement?.dataset.directoryId;
  const query = $('directory-search').value.trim().toLocaleLowerCase();
  const people = directoryPeople.filter(p => p.kind === directoryKind && (!query || [p.displayName, p.principalId, p.instanceLabel, publicProfile(p).headline, publicProfile(p).summary, ...(publicProfile(p).expertise ?? [])].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(query))));
  $('show-contacts').setAttribute('aria-pressed', String(directoryKind === 'human')); $('show-bots').setAttribute('aria-pressed', String(directoryKind === 'bot'));
  $('directory-count').textContent = people.length + (directoryKind === 'bot' ? ' 个 Bot' : ' 位联系人');
  if (!people.some(p => p.principalId === directorySelection)) directorySelection = undefined;
  const list = $('directory-list'), pane = $('directory-profile'); pane.remove();
  list.replaceChildren(...people.map(directoryRow));
  const selected = [...list.children].find(row => row.firstElementChild?.dataset.directoryId === directorySelection);
  (selected ?? document.querySelector('.directory-layout')).append(pane);
  if (!people.length) list.append(text('p', query ? '没有匹配的联系人或 Bot。' : directoryKind === 'bot' ? '暂无已发布的 Bot。' : '暂无已加入的联系人。'));
  renderDirectoryProfile(people.find(p => p.principalId === directorySelection));
  if (focused) [...document.querySelectorAll('[data-directory-id]')].find(node => node.dataset.directoryId === focused)?.focus({preventScroll:true});
}
function updateDirectory(participants = []) {
  directoryPeople = participants;
  const valid = new Set(participants.filter(p => p.avatar?.imageRevision).map(p => JSON.stringify([p.principalId, p.avatar.imageRevision])));
  for (const key of directoryImages.keys()) if (!valid.has(key)) directoryImages.delete(key);
  renderDirectory();
}
$('show-contacts').onclick = () => { directoryKind = 'human'; renderDirectory(); };
$('show-bots').onclick = () => { directoryKind = 'bot'; renderDirectory(); };
$('directory-search').oninput = renderDirectory;
`

export const directoryCSS = `
.directory-heading,.directory-tools,.directory-tabs,.directory-profile-heading{display:flex;align-items:center;gap:12px}.directory-heading{justify-content:space-between}.directory-heading h2{margin:0}.directory-heading p{font-size:12px;color:var(--bt-ink-2);margin:4px 0 16px}.directory-count{font-size:12px;color:var(--bt-ink-2)}.directory-tools{justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}.directory-tabs{gap:4px;background:var(--bt-sidebar);padding:4px;border-radius:12px}.directory-tabs button{border-color:transparent;background:transparent}.directory-tabs button[aria-pressed=true]{background:var(--bt-card);border-color:var(--bt-line-2);color:var(--bt-accent)}.directory-search{min-width:min(260px,100%);flex:1;max-width:380px}.directory-layout{display:block}#directory-list{min-width:0}#directory-profile{margin:0 8px 10px 20px;padding:8px 12px 12px;border-left:2px solid var(--bt-line)}#directory-list>p,#directory-profile>p{font-size:13px;color:var(--bt-ink-2)}.directory-row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;margin:0;min-height:40px;text-align:left;border:1px solid transparent;border-radius:12px;background:transparent}.directory-row[aria-pressed=true]{background:var(--bt-sidebar);border-color:var(--bt-line)}.directory-row-copy{display:flex;flex:1;min-width:0;flex-direction:row;align-items:center;gap:8px}.directory-row-copy strong{font-size:13px;font-weight:500;flex:0 0 auto;max-width:45%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.directory-row-copy>span{font-size:12px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.directory-source{font-size:11px;color:var(--bt-ink-2);overflow-wrap:anywhere}.directory-avatar{display:grid;place-items:center;width:28px;height:28px;flex:0 0 28px;overflow:hidden;border-radius:50%;background:var(--bt-bubble);color:var(--bt-ink-2);font-size:13px;font-weight:500}.directory-avatar[data-kind=bot]{border-radius:12px;color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 9%,var(--bt-card))}.directory-avatar-large{width:64px;height:64px;flex-basis:64px;font-size:22px}.directory-avatar img{width:100%;height:100%;object-fit:cover}.directory-presence{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:var(--bt-line-2)}.directory-presence[data-connected=true]{background:var(--bt-accent)}.directory-profile-heading{margin:8px 0 16px;align-items:center}.directory-profile-heading h3{font-size:17px;font-weight:500;margin:0;overflow-wrap:anywhere}.directory-profile-heading p{font-size:13px;color:var(--bt-ink-2);margin:4px 0 0;overflow-wrap:anywhere}.directory-connection{font-size:11px;color:var(--bt-ink-2)}.directory-about{white-space:pre-wrap;overflow-wrap:anywhere}.directory-tags{display:flex;flex-wrap:wrap;gap:6px}.directory-tags span{font-size:12px;border-radius:8px;background:var(--bt-sidebar);padding:4px 8px;overflow-wrap:anywhere}#directory-profile h4{font-size:13px;font-weight:500;margin:20px 0 8px}.directory-owned-bot .directory-row{padding-left:0}.directory-identity{margin-top:20px}.directory-identity code{font-size:11px}.directory-identity p{font-size:12px;color:var(--bt-ink-2)}
.directory-chevron{flex:none;color:var(--bt-ink-2)}.directory-row-copy small{font-size:11px;color:var(--bt-danger)}.directory-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
@media(max-width:600px){#directory-profile{margin-left:12px;padding:6px 10px}.directory-search{max-width:none;width:100%}.directory-heading{align-items:flex-start}.directory-count{white-space:nowrap}}
`
