import { createElement as h, useEffect, useRef, useState } from 'react'
import { Switch } from './bot-settings.js'
import { CommunicationActionDialog } from './communication-dialog.js'
import { communicationFailure } from './communication-errors.js'
import { useLiveRefresh } from './communication-live.js'
import { remoteHubVisible } from '../shared/remote-hub.js'
import { t } from './i18n.js'

export function RemoteHubSetting({ roster, actions }) {
  const [status,setStatus] = useState(null), [confirm,setConfirm] = useState(null), [busy,setBusy] = useState(false), [error,setError] = useState('')
  const live = useRef(true), working = useRef(false), order = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false; order.current += 1 } }, [])
  useLiveRefresh(async () => {
    if (working.current) return
    const request = ++order.current, value = await actions.remoteHubSettings()
    if (live.current && request === order.current) { setStatus(value); setError('') }
  }, failure => { if (live.current) setError(communicationFailure(failure)) }, actions.remoteHubSettings,
  `${roster.remoteHubEnabled}:${roster.remoteHubWithdrawalPending}:${roster.remoteHubWithdrawalError}`)
  const save = async (enabled, preview) => {
    working.current = true; order.current += 1; setBusy(true)
    try {
      const result = await actions.setRemoteHubEnabled({enabled,expectedVersion:preview.version,...(!enabled?{confirmHideAllBots:true}:{})})
      if (live.current) { setStatus(result); setError('') }
      return result
    } finally { working.current = false; if (live.current) setBusy(false) }
  }
  const toggle = async enabled => {
    if (working.current) return
    working.current = true; order.current += 1; setBusy(true); setError('')
    try {
      const preview = await actions.remoteHubSettings()
      if (!live.current) return
      setStatus(preview)
      if (enabled) await save(true,preview)
      else if (preview.enabled) setConfirm(preview)
    } catch (failure) { if (live.current) setError(communicationFailure(failure)) }
    finally { working.current = false; if (live.current) setBusy(false) }
  }
  const enabled = status?.enabled ?? remoteHubVisible(roster)
  return h('section',{className:'bt-set-section bt-remote-hub-setting'},h('h3',null,t('Remote communication')),
    h('div',{className:'bt-set-card'},h('div',{className:'bt-set-row'},
      h('div',{className:'bt-set-copy'},h('span',null,t('Enable remote Hub')),h('span',{className:'bt-set-hint'},t('Show remote communication and allow this device to connect to a Hub.'))),
      h('div',{className:'bt-set-control'},h(Switch,{on:enabled,label:t('Enable remote Hub'),disabled:busy||Boolean(roster.readOnly),onChange:value=>{void toggle(value)}}))),
      status?.withdrawalPending ? h('p',{className:'bt-set-hint',role:'status'},t('Remote communication is stopped locally. Hiding Bots on the Hub is pending and will retry when the Hub is reachable.'),status.withdrawalError?' '+status.withdrawalError:'') :
        status?.reloadRequired ? h('p',{className:'bt-set-hint',role:'status'},t('Settings saved. Waiting for the Host configuration reload.')) : null,
      error ? h('p',{className:'bt-comm-error',role:'alert'},t(error)) : null),
    h(CommunicationActionDialog,{open:Boolean(confirm),title:'Disable remote Hub',confirmLabel:'Hide all Bots and disable',danger:true,onClose:()=>setConfirm(null),onConfirm:()=>save(false,confirm)},
      h('p',null,t('This hides every Bot published by this device on the selected Hub and stops remote communication.')),
      h('ul',null,
        h('li',null,t('Their current remote identities permanently end, and their group memberships and roles are removed.')),
        h('li',null,t('Old private chats become read-only. Remote tasks may be interrupted.')),
        h('li',null,t('Turning this on again does not republish Bots. Publish them explicitly with new identities and add them to groups again.')),
        h('li',null,t('Your local Bots, files, chats, contacts and saved Hub enrollment are kept.')),
        h('li',null,t('If the Hub is unreachable, this device stops immediately and retries hiding Bots in the background.')))))
}
