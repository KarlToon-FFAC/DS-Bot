import {createHash} from 'node:crypto'
const fail=code=>{throw Object.assign(new Error(code),{code})}
const excerpt=(text,query)=>{
 const characters=Array.from(text),index=text.toLowerCase().indexOf(query.toLowerCase()),start=Math.max(0,Array.from(text.slice(0,Math.max(0,index))).length-60)
 return (start?'…':'')+characters.slice(start,start+220).join('').replace(/\p{Cc}/gu,' ')+(start+220<characters.length?'…':'')
}
// Scopes come exclusively from the same memberships/owned DM records as history.
// The cursor positions a page; it never supplies a principal or widens authority.
export function searchHistory(queue,contexts,{query,cursor,limit=20}={}){
 if(typeof query!=='string'||!query.trim()||[...query.trim()].length>200||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('INVALID_REQUEST')
 query=query.trim()
 contexts=contexts.map(context=>({...context,upper:queue.cursor(context.conversationId,context.principalId,context.membershipEpoch)})).sort((a,b)=>a.conversationId.localeCompare(b.conversationId))
 for(const item of contexts)queue.member(item.conversationId,item.principalId,item.membershipEpoch)
 const key=createHash('sha256').update(JSON.stringify([query,contexts.map(item=>[item.conversationId,item.principalId,item.membershipEpoch,item.joinSeq])])).digest('hex')
 let after
 if(cursor!==undefined){
  if(typeof cursor!=='string'||cursor.length>2048)fail('INVALID_CURSOR')
  try{after=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))}catch{fail('INVALID_CURSOR')}
  if(!after||typeof after.stamp!=='string'||after.stamp.length>64||typeof after.id!=='string'||after.id.length>200||!Number.isSafeInteger(after.seq)||after.seq<0)fail('INVALID_CURSOR')
  if(after.key!==key)fail('HISTORY_SEARCH_CHANGED')
 }
 if(!contexts.length)return {results:[],hasMore:false,nextCursor:null}
 const rows=queue.db.prepare(`WITH allowed AS (SELECT value FROM json_each(?)), hits AS (
   SELECT e.conversation_id id,e.principal_id principal,e.epoch,e.seq,e.body,COALESCE(json_extract(e.body,'$.serverAcceptedAt'),'') stamp
   FROM events e JOIN allowed a ON e.conversation_id=json_extract(a.value,'$.conversationId') AND e.principal_id=json_extract(a.value,'$.principalId') AND e.epoch=json_extract(a.value,'$.membershipEpoch')
   WHERE e.seq>=json_extract(a.value,'$.joinSeq') AND e.seq<=json_extract(a.value,'$.upper') AND json_extract(e.body,'$.type')='message'
     AND instr(lower(json_extract(e.body,'$.message.content.text')),lower(?))>0)
   SELECT * FROM hits WHERE ?=0 OR stamp<? OR (stamp=? AND (id>? OR (id=? AND seq<?))) ORDER BY stamp DESC,id ASC,seq DESC LIMIT ?`)
  .all(JSON.stringify(contexts),query,Number(Boolean(after)),after?.stamp??'',after?.stamp??'',after?.id??'',after?.id??'',after?.seq??0,limit+1)
 const selected=rows.slice(0,limit),last=selected.at(-1),byId=new Map(contexts.map(item=>[item.conversationId,item]))
 return {results:selected.map(row=>{
  const event=JSON.parse(row.body),message=event.message,context=byId.get(row.id)
  return {conversationId:row.id,membershipEpoch:row.epoch,localBotId:context.viewerBotId,conversationSeq:row.seq,messageId:message.messageId,
   author:{principalId:message.author.principalId,kind:message.author.kind,displayName:message.author.displayName},serverAcceptedAt:event.serverAcceptedAt,excerpt:excerpt(message.content.text,query)}
 }),hasMore:rows.length>limit,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({key,stamp:last.stamp,id:last.id,seq:last.seq})).toString('base64url'):null}
}
