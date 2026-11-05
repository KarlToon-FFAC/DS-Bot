import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { avatarImage } from './avatar-library.js'
import { principalAvatar } from './communication-model.js'
import { t } from './i18n.js'

const images = new Map(), requests = new Map(), authorized = new Map()
let avatarScope = 'legacy'
export function safeAvatarImage(value) {
  return typeof value === 'string' && value.length <= 160000 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null
}
export function syncAvatarDirectory(contacts, scope = 'legacy') {
  if(scope !== avatarScope){avatarScope=scope;images.clear();requests.clear()}
  authorized.clear()
  for (const person of contacts) if (person.avatar?.imageRevision) authorized.set(person.principalId, person.avatar.imageRevision)
  for (const key of images.keys()) {
    const [,principalId, revision] = JSON.parse(key)
    if (authorized.get(principalId) !== revision) images.delete(key)
  }
}
export function CommunicationAvatar({ person, request, allowed = true, size = 28 }) {
  const revision = allowed ? person.avatar?.imageRevision : null
  const scope = avatarScope, key = JSON.stringify([scope,person.principalId, revision])
  const [loaded, setLoaded] = useState(null)
  useEffect(() => {
    let active = true
    setLoaded(null)
    if (!revision) return undefined
    const cached = images.get(key)
    if (cached) { setLoaded({ key, image: cached }); return undefined }
    if (!requests.has(key)) {
      const promise = request({ endpoint: 'avatar', principalId: person.principalId, revision }).then(value => {
        const image = value.principalId && value.principalId !== person.principalId || value.revision && value.revision !== revision ? null : safeAvatarImage(value.image)
        if (image && scope === avatarScope && authorized.get(person.principalId) === revision) images.set(key, image)
        return image
      }).catch(() => null).finally(() => requests.delete(key))
      requests.set(key, promise)
    }
    void requests.get(key).then(image => { if (active && image) setLoaded({ key, image }) })
    return () => { active = false }
  }, [key, request, revision, person.principalId])
  const image = loaded?.key === key ? loaded.image : null
  const bot = person.kind === 'bot' || person.principalId?.startsWith('bot:')
  const value = principalAvatar(person.kind === 'human' || person.principalId?.startsWith('human:') ? person.displayName ?? 'Human' : person.principalId, person.displayName ?? '')
  return h('span', { className: 'bt-comm-avatar', 'data-avatar': value.variant, 'data-kind': bot ? 'bot' : person.kind, 'data-avatar-id': person.principalId, 'data-initials': !bot && !image ? value.initials : undefined,
    'data-has-image': Boolean(image), 'aria-hidden': true, style: { width: size, height: size, flexBasis: size, fontSize: Math.min(11, size * .45), lineHeight: 1, overflow: 'hidden' } },
    bot ? h(BotMark, { bot: { id: person.avatar?.seed ?? person.principalId, color: person.avatar?.color, avatar: { shape: person.avatar?.shape, ...(image ? { image } : {}) } }, size }) :
      image ? h('img', { src: image, alt: '', width: size, height: size, draggable: false }) : null)
}

export function HumanProfile({ human, request, operation, onSaved, convertImage = avatarImage }) {
  const [name, setName] = useState(human.displayName ?? 'Human'), [avatar, setAvatar] = useState(undefined)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), fileOrder = useRef(0), edits = useRef(0)
  const [base, setBase] = useState({ name: human.displayName ?? 'Human' })
  useEffect(() => () => { generation.current += 1; fileOrder.current += 1 }, [])
  const dirty = name !== base.name || avatar !== undefined
  const upload = async file => {
    if (!file) return
    const order = ++fileOrder.current
    try {
      const image = await convertImage(file)
      if (!safeAvatarImage(image)) throw new Error(t('Choose a PNG, JPEG, WebP, or GIF image'))
      if (order === fileOrder.current) { edits.current += 1; setAvatar({ image }); setError('') }
    } catch (failure) { if (order === fileOrder.current) setError(failure.message ?? t('Unable to update profile')) }
  }
  const commit = async () => {
    if (busy || !dirty) return
    const token = generation.current, revision = edits.current, submittedName = name
    const payload = { ...(name === base.name ? {} : { displayName: name }), ...(avatar === undefined ? {} : { avatar }) }
    setBusy(true); setError('')
    try {
      const result = await operation('profile-human', payload)
      if (token !== generation.current) return
      if (result.status === 'queued') { setError(t('An operation is not confirmed. Check status, then retry the same action.')); return }
      setBase({ name: submittedName })
      if (revision === edits.current) setAvatar(undefined)
      onSaved?.()
    } catch { if (token === generation.current) setError(t('Unable to update profile')) }
    finally { if (token === generation.current) setBusy(false) }
  }
  return h('section', { className: 'bt-comm-profile' },
    h('div', { className: 'bt-comm-profile-preview' }, avatar?.image ? h('img', { src: avatar.image, alt: t('Avatar preview'), width: 64, height: 64 }) :
      h(CommunicationAvatar, { person: { ...human, displayName: name, ...(avatar === null ? { avatar: {} } : {}) }, request, size: 64 })),
    h('label', { className: 'bt-comm-field' }, t('Human name'), h('input', { value: name, 'aria-label': t('Human name'), onChange: event => { edits.current += 1; setName(event.target.value) } })),
    h('label', { className: 'bt-comm-field' }, t('Upload avatar'), h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': t('Upload avatar'), onChange: event => { void upload(event.target.files?.[0]); event.target.value = '' } })),
    h('button', { type: 'button', onClick: () => { fileOrder.current += 1; edits.current += 1; setAvatar(null) } }, t('Reset avatar')),
    h('button', { type: 'button', disabled: busy || !dirty || !name.trim(), onClick: () => { void commit() }, 'data-dirty': dirty, 'aria-label': t('Save profile') }, t('Save profile')),
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null)
}
