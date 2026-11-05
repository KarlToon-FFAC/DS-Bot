import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

const MAX_BYTES=65536, MAX_FILES=4
const EMPTY=[]
const raster = /^(image\/(png|jpeg|gif|webp))$/
const fail = code => { throw Object.assign(new Error(code),{code}) }
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')
export async function selectedAttachments(files, existing=[]) {
  if(existing.length+files.length>MAX_FILES)fail('INVALID_ATTACHMENT')
  let total=existing.reduce((sum,file)=>sum+file.size,0)
  const added=[]
  for(const file of files){
    total+=file.size
    if(file.size<1||total>MAX_BYTES)fail('ATTACHMENT_TOO_LARGE')
    if(!file.name||file.name.length>180||/[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(file.name))fail('INVALID_ATTACHMENT')
    const bytes=new Uint8Array(await file.arrayBuffer())
    let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte)
    added.push({name:file.name,mime:raster.test(file.type)?file.type:'application/octet-stream',size:bytes.length,sha256:await hash(bytes),data:window.btoa(raw)})
  }
  return [...existing,...added]
}

export function CommunicationAttachments({files=EMPTY}) {
  const [verified,setVerified]=useState([]),[error,setError]=useState(false)
  useEffect(()=>{
    let active=true
    setVerified([]);setError(false)
    void (async()=>{
      if(!Array.isArray(files)||files.length>MAX_FILES)throw Error()
      let total=0
      const result=[]
      for(const file of files){
        if(typeof file.data!=='string'||file.data.length>87384||typeof file.name!=='string'||file.name.length>180||!Number.isInteger(file.size)||file.size<1)throw Error()
        total+=file.size;if(total>MAX_BYTES)throw Error()
        const bytes=Uint8Array.from(window.atob(file.data),char=>char.charCodeAt(0))
        if(bytes.length!==file.size||await hash(bytes)!==file.sha256)throw Error()
        result.push({...file,bytes})
      }
      if(active)setVerified(result)
    })().catch(()=>{if(active)setError(true)})
    return()=>{active=false}
  },[files])
  const download=file=>{
    // All non-image content stays inert; never open HTML/SVG/PDF in this origin.
    const url=URL.createObjectURL(new window.Blob([file.bytes],{type:'application/octet-stream'}))
    const link=document.createElement('a');link.href=url;link.download=file.name;link.rel='noopener';link.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  return h('div',{className:'bt-comm-attachments'},error?h('span',{role:'status'},t('Attachment could not be verified.')):null,
    verified.map((file,index)=>h('div',{className:'bt-comm-attachment',key:index},
      raster.test(file.mime)?h('img',{src:`data:${file.mime};base64,${file.data}`,alt:file.name,loading:'lazy',onLoad:event=>{if(event.target.naturalWidth*event.target.naturalHeight>20000000)event.target.hidden=true}}):null,
      h('button',{type:'button',onClick:()=>download(file),'aria-label':t('Download {name}',{name:file.name})},h('span',null,file.name),h('small',null,`${file.size} B`)))))
}
