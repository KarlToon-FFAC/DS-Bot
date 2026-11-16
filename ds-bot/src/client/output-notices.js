import {createElement as h,useEffect,useState} from 'react'
import {t} from './i18n.js'
export function OutputNotices({sessionId,useRoster,actions}) {
  const roster=useRoster(value=>value), [open,setOpen]=useState(false),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
  const bot=roster.bots?.find(bot=>bot.sessionId===sessionId || bot.id===sessionId || bot.parts?.includes(sessionId))
  const rows=bot?roster.unpublishedOutputs?.[bot.id]??[]:[]
  if(!rows.length)return null
  const run=async task=>{if(busy)return;setBusy(true);setError('');try{await task()}catch(error){setError(error.message??t('Output was not confirmed'))}finally{setBusy(false)}}
  return h('section',{className:'bt-output-notices','aria-label':t('Unpublished output')},
    h('button',{type:'button','aria-expanded':open,onClick:()=>setOpen(!open)},t('Unpublished output'),' · ',rows.length),
    open?h('div',{className:'bt-output-list'},rows.map(row=>h('article',{key:row.id},
      h('p',null,t(row.status==='unsubmitted-text'?'Not automatically published':'Delivery not confirmed'),' · ',t('Turn'),' ',row.turn),
      h('p',null,row.head),
      h('button',{type:'button',disabled:busy,onClick:()=>run(async()=>{const result=await actions.readTurnOutput(bot.id,row.id);setPreview({id:row.id,text:result.text})})},t('Read saved text')),
      h('button',{type:'button',disabled:busy||row.status!=='unsubmitted-text',onClick:()=>run(()=>actions.submitTurnOutput(bot.id,row.id))},t('Publish saved text to my chat')),
      preview?.id===row.id?h('pre',{className:'bt-output-preview'},preview.text):null))):null,
    error?h('p',{role:'alert'},error):null)
}
export const OUTPUT_NOTICE_CSS=`
.bt-output-notices{color:var(--bt-ink);background:var(--bt-card);border:1px solid var(--bt-line);border-radius:12px;padding:8px 12px;margin:4px 0;max-width:100%;min-width:0}
.bt-output-notices button{color:var(--bt-accent,var(--bt-ink));background:transparent;border:1px solid var(--bt-line);border-radius:8px;padding:6px 10px;cursor:pointer;margin:2px}
.bt-output-list{max-height:240px;overflow:auto}.bt-output-list article{border-top:1px solid var(--bt-line);padding:8px 0;overflow-wrap:anywhere}.bt-output-list p{margin:4px 0}.bt-output-preview{white-space:pre-wrap;max-height:180px;overflow:auto;color:var(--bt-ink);font:inherit}
`

export function RecoveredOutputTail({sessionId,turn,useRoster,actions}){
  const roster=useRoster(value=>value),[texts,setTexts]=useState([]),[error,setError]=useState('')
  const matches=(roster.recoveredOutputIds??[]).filter(row=>row.sessionId===sessionId&&row.turn===turn?.turn)
  const key=matches.map(row=>row.id).join('|')
  useEffect(()=>{let live=true;setTexts([]);setError('');if(matches.length)Promise.all(matches.map(row=>actions.readTurnOutput(row.botId,row.id))).then(rows=>{if(live)setTexts(rows)},()=>{if(live)setError(t('Output was not confirmed'))});return()=>{live=false}},[key,sessionId,actions])
  if(!matches.length)return null
  return h('section',{className:'bt-output-notices','aria-label':t('Published saved output')},h('p',null,t('Published saved output')),texts.map(row=>h('div',{key:row.id,className:'bt-output-preview'},row.text)),error?h('p',{role:'alert'},error):null)
}
