// Schema 2 separates observed visibility from actual delivery and private decisions.
export const OUTPUT_SCHEMA = 2
export const deliveryConfirmed = status => ['submitted-bot','delivered-auto'].includes(status)
export function migrateOutput(row) {
  if(row.routingSchemaVersion>OUTPUT_SCHEMA)throw Object.assign(new Error('This output needs a newer routing schema.'),{code:'OUTPUT_SCHEMA_UNSUPPORTED'})
  if(row.routingSchemaVersion===OUTPUT_SCHEMA)return row
  row.visibility=Array.isArray(row.visibility)?row.visibility:[]
  row.deliveries=Array.isArray(row.deliveries)?row.deliveries:[]
  row.legacyStatus=row.status
  if(row.status==='submitted-user')row.visibility.push({id:`legacy:${row.id}`,channel:'legacy-classification',audience:'user',at:row.at,confirmed:false})
  for(const [index,route] of (row.routes??[]).entries())row.deliveries.push({...route,receiptId:`legacy:${row.id}:${index}`,confirmed:deliveryConfirmed(route.status),legacy:true})
  row.pending=row.status==='unsubmitted-text'?{owner:'self',authorizedBy:row.botId,reason:'unsubmitted-text',at:row.at}:null
  row.routingSchemaVersion=OUTPUT_SCHEMA
  return row
}
export function addVisibility(row,fact) {
  migrateOutput(row)
  if(!row.visibility.some(old=>old.id===fact.id))row.visibility.push({...fact,audience:'user'})
}
export const isUserSubmitted = row => (row.visibility??[]).some(fact=>fact.confirmed===true && fact.channel!=='legacy-classification')
export function outputPending(row,reason='unsubmitted-text') {
  migrateOutput(row)
  row.pending ??= {owner:'self',authorizedBy:row.botId,at:Date.now(),reason}
  row.status='unsubmitted-text'
}
export function settleOutput(row,status) {
  migrateOutput(row)
  row.status=status
  if(deliveryConfirmed(status)||status==='waiting-subtask'||status==='no-reply-chosen'||status==='submitted-user')row.pending=null
}
