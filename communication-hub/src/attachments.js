import { createHash } from 'node:crypto'

// Deliberately small, inline and covered by the authenticated message envelope.
// No URL, filesystem path, separate download credential or public blob endpoint.
export const ATTACHMENT_CAPABILITY = 'inline-attachments-v1'
export const MAX_ATTACHMENT_BYTES = 65536
export const MAX_ATTACHMENTS = 4
const fail = code => { throw Object.assign(new Error(code), { code }) }
function imageDimensions(bytes,mime) {
  if(mime==='image/png'&&bytes.length>=24)return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)]
  if(mime==='image/gif'&&bytes.length>=10)return [bytes.readUInt16LE(6),bytes.readUInt16LE(8)]
  if(mime==='image/webp'&&bytes.length>=30){
    const format=bytes.subarray(12,16).toString('ascii')
    if(format==='VP8X')return [1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3)]
    if(format==='VP8L'&&bytes[20]===47){const n=bytes.readUInt32LE(21);return [(n&16383)+1,((n>>>14)&16383)+1]}
    if(format==='VP8 '&&bytes.subarray(23,26).equals(Buffer.from([157,1,42])))return [bytes.readUInt16LE(26)&16383,bytes.readUInt16LE(28)&16383]
  }
  if(mime==='image/jpeg')for(let offset=2;offset+4<bytes.length;){
    if(bytes[offset]!==255)break
    const marker=bytes[offset+1],length=bytes.readUInt16BE(offset+2)
    if(length<2||offset+2+length>bytes.length)break
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return [bytes.readUInt16BE(offset+7),bytes.readUInt16BE(offset+5)]
    offset+=2+length
  }
  return []
}
export function normalizeAttachments(input) {
  if (input === undefined) return []
  if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) fail('INVALID_ATTACHMENT')
  let total = 0
  return input.map(file => {
    if (!file || typeof file !== 'object' || Object.keys(file).sort().join(',') !== 'data,mime,name,sha256,size'
      || typeof file.name !== 'string' || !file.name.isWellFormed() || !file.name.trim() || file.name.length > 180
      || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/u.test(file.name)
      || ['.','..'].includes(file.name) || typeof file.mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(file.mime)
      || file.mime.length > 100 || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES
      || typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) fail('INVALID_ATTACHMENT')
    const bytes = Buffer.from(file.data, 'base64')
    if (bytes.length !== file.size || bytes.toString('base64') !== file.data
      || createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('ATTACHMENT_INTEGRITY_FAILED')
    total += file.size
    if (total > MAX_ATTACHMENT_BYTES) fail('ATTACHMENT_TOO_LARGE')
    if (file.mime.startsWith('image/')) {
      const valid = file.mime === 'image/png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : file.mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : file.mime === 'image/gif' ? ['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii'))
            : file.mime === 'image/webp' && bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP'
      if (!valid) fail('INVALID_ATTACHMENT_IMAGE')
      const [width,height]=imageDimensions(bytes,file.mime)
      if(!width||!height||width>8192||height>8192||width*height>20000000)fail('INVALID_ATTACHMENT_IMAGE')
    }
    return { name:file.name, mime:file.mime, size:file.size, sha256:file.sha256, data:file.data }
  })
}

export const attachmentMetadata = input => (input ?? []).map(({name,mime,size,sha256}) => ({name,mime,size,sha256}))
