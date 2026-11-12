import {BotPresenceBadge} from './communication-presence.js'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { BotMark } from './mark.js'
import { avatarImage } from './avatar-library.js'
import { principalAvatar } from './communication-model.js'
import { t } from './i18n.js'
import { communicationFailure, knownCommunicationFailure } from './communication-errors.js'

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
    'data-has-image': Boolean(image), style: { width: size, height: size, flexBasis: size, fontSize: Math.min(11, size * .45), lineHeight: 1, position: 'relative', overflow: bot ? 'visible' : 'hidden' } },
    bot ? h(BotMark, { bot: { id: person.avatar?.seed ?? person.principalId, color: person.avatar?.color, avatar: { shape: person.avatar?.shape, ...(image ? { image } : {}) } }, size }) :
      image ? h('img', { src: image, alt: '', width: size, height: size, draggable: false }) : null, bot ? h(BotPresenceBadge,{person}) : null)
}

const profileValues = value => ({ headline: value?.headline ?? '', summary: value?.summary ?? '',
  expertise: value?.expertise ?? [], languages: value?.languages ?? [] })
const profileDraft = value => ({ ...profileValues(value), expertise: (value?.expertise ?? []).join(', '), languages: (value?.languages ?? []).join(', ') })
const profileTerms = value => [...new Set(value.split(/[,，\n]/).map(term => term.trim()).filter(Boolean))]
const submittedProfile = draft => ({ headline: draft.headline.trim(), summary: draft.summary.trim(), expertise: profileTerms(draft.expertise), languages: profileTerms(draft.languages) })

export function PublicProfileFields({ profile, onChange, disabled = false }) {
  const field = (key, label, limit, multiline = false) => h('label', { className: 'bt-comm-field' }, t(label),
    h(multiline ? 'textarea' : 'input', { value: profile[key], 'aria-label': t(label), disabled, maxLength: limit,
      ...(multiline ? { rows: 4 } : {}), onChange: event => onChange(key, event.target.value) }))
  return h('div', { className: 'bt-comm-public-profile-fields' },
    field('headline', 'Role or specialty', 80), field('summary', 'Profile summary', 1000, true),
    field('expertise', 'Expertise (comma-separated)', 500))
}

export function HumanProfile({ human, request, operation, onSaved, convertImage = avatarImage }) {
  const [name, setName] = useState(human.displayName ?? 'Human'), [avatar, setAvatar] = useState(undefined)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0), fileOrder = useRef(0), edits = useRef(0), loadedInfo = useRef(false)
  const [base, setBase] = useState({ name: human.displayName ?? 'Human' })
  const [profile, setProfile] = useState(() => profileDraft(human.publicProfile))
  const [profileBase, setProfileBase] = useState(() => ({ ...profileValues(human.publicProfile), version: human.publicProfile?.version ?? 0 }))
  const [conflict, setConflict] = useState(false), [latest, setLatest] = useState(null)
  const [profileReady, setProfileReady] = useState(false), [profileLoading, setProfileLoading] = useState(true), [profileLoadError, setProfileLoadError] = useState('')
  useEffect(() => () => { generation.current += 1; fileOrder.current += 1 }, [])
  const infoDirty = JSON.stringify(submittedProfile(profile)) !== JSON.stringify(profileValues(profileBase))
  const identityDirty = name !== base.name || avatar !== undefined
  const dirty = identityDirty || infoDirty
  const checkedInfo = result => {
    const value = result?.publicProfile
    if (result?.principalId !== human.principalId || !value || value.truncated
      || !Number.isSafeInteger(value.version) || value.version < 0) throw new Error('INVALID_PUBLIC_PROFILE_RESPONSE')
    return value
  }
  useEffect(() => {
    let active = true
    loadedInfo.current = false
    setProfileReady(false); setProfileLoading(true); setProfileLoadError('')
    void request({ endpoint: 'human-profile-info' }).then(result => {
      if (!active) return
      const value = checkedInfo(result)
      setProfile(profileDraft(value)); setProfileBase({ ...profileValues(value), version: value.version }); setProfileReady(true); loadedInfo.current = true
    }).catch(failure => { if (active) setProfileLoadError(knownCommunicationFailure(failure) ? communicationFailure(failure) : t('Unable to load profile details')) })
      .finally(() => { if (active) setProfileLoading(false) })
    return () => { active = false }
  }, [human.principalId, request])
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
    if (busy || !dirty || conflict || infoDirty && !profileReady) return
    const token = generation.current, revision = edits.current, submittedName = name
    const payload = { ...(name === base.name ? {} : { displayName: name }), ...(avatar === undefined ? {} : { avatar }) }
    const info = submittedProfile(profile)
    setBusy(true); setError('')
    try {
      if (identityDirty) {
        const result = await operation('profile-human', payload)
        if (token !== generation.current) return
        if (result.status === 'queued') { setError(t('An operation is not confirmed. Check status, then retry the same action.')); return }
        setBase({ name: submittedName })
        if (revision === edits.current) setAvatar(undefined)
      }
      if (infoDirty) {
        const result = await operation('profile-human-info', { expectedVersion: profileBase.version, profile: info })
        if (token !== generation.current) return
        if (result.status === 'queued') { setError(t('An operation is not confirmed. Check status, then retry the same action.')); return }
        if (!result.publicProfile || !Number.isSafeInteger(result.publicProfile.version)) throw new Error('INVALID_PUBLIC_PROFILE_RESPONSE')
        setProfileBase({ ...profileValues(result.publicProfile), version: result.publicProfile.version })
        setLatest(null)
        try {
          const current = checkedInfo(await request({ endpoint: 'human-profile-info' }))
          if (token !== generation.current) return
          if (current.version < result.publicProfile.version) throw new Error('INVALID_PUBLIC_PROFILE_RESPONSE')
          if (current.version > result.publicProfile.version) {
            setLatest(profileValues(current)); setConflict(true)
            setError(t('Profile changed elsewhere. Your edits are kept. Review the latest profile before saving.'))
          } else setProfileBase({ ...profileValues(current), version: current.version })
        } catch {
          if (token !== generation.current) return
          setProfileReady(false)
          setProfileLoadError(t('Profile saved, but the latest details could not be loaded'))
        }
      }
      onSaved?.()
    } catch (failure) {
      if (token !== generation.current) return
      if (['PROFILE_VERSION_CONFLICT', 'PUBLIC_PROFILE_VERSION_CONFLICT'].includes(failure.code)
        || ['PROFILE_VERSION_CONFLICT', 'PUBLIC_PROFILE_VERSION_CONFLICT'].includes(failure.message)) {
        setConflict(true)
        setError(t('Profile changed elsewhere. Your edits are kept. Review the latest profile before saving.'))
      } else setError(knownCommunicationFailure(failure) ? communicationFailure(failure) : t('Unable to update profile'))
    }
    finally { if (token === generation.current) setBusy(false) }
  }
  const reviewLatest = async () => {
    if (busy) return
    const token = generation.current
    setBusy(true); setError('')
    try {
      const result = await request({ endpoint: 'human-profile-info' })
      if (token !== generation.current) return
      const value = checkedInfo(result)
      if (!loadedInfo.current) setProfile(profileDraft(value))
      setProfileBase({ ...profileValues(value), version: value.version })
      setLatest(profileValues(value)); setConflict(false); setProfileReady(true); setProfileLoadError(''); loadedInfo.current = true
    } catch { if (token === generation.current) setError(t('Unable to load the latest profile')) }
    finally { if (token === generation.current) setBusy(false) }
  }
  return h('section', { className: 'bt-comm-profile' },
    h('div', { className: 'bt-comm-profile-preview' }, avatar?.image ? h('img', { src: avatar.image, alt: t('Avatar preview'), width: 64, height: 64 }) :
      h(CommunicationAvatar, { person: { ...human, displayName: name, ...(avatar === null ? { avatar: {} } : {}) }, request, size: 64 })),
    h('label', { className: 'bt-comm-field' }, t('Human name'), h('input', { value: name, 'aria-label': t('Human name'), onChange: event => { edits.current += 1; setName(event.target.value) } })),
    h('label', { className: 'bt-comm-field' }, t('Upload avatar'), h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': t('Upload avatar'), onChange: event => { void upload(event.target.files?.[0]); event.target.value = '' } })),
    h('button', { type: 'button', onClick: () => { fileOrder.current += 1; edits.current += 1; setAvatar(null) } }, t('Reset avatar')),
    h('p', { className: 'bt-comm-reference' }, t('Describe your responsibilities and the help you can offer. Only share information intended for your contacts.')),
    profileLoading ? h('p', { className: 'bt-comm-reference', role: 'status' }, t('Loading profile details…')) : null,
    profileLoadError ? h('p', { className: 'bt-comm-error', role: 'alert' }, profileLoadError) : null,
    h(PublicProfileFields, { profile, disabled: busy || !profileReady, onChange: (key, value) => setProfile(current => ({ ...current, [key]: value })) }),
    latest ? h('section', { className: 'bt-comm-latest-profile', 'aria-label': t('Latest shared profile') }, h('h3', null, t('Latest shared profile')),
      h('p', null, latest.headline || t('No role or specialty')), h('p', null, latest.summary || t('No profile summary')),
      h('p', null, latest.expertise.join(', '))) : null,
    conflict || profileLoadError ? h('button', { type: 'button', disabled: busy, onClick: () => { void reviewLatest() } }, t(conflict ? 'Review latest profile' : 'Reload profile details')) : null,
    h('button', { type: 'button', disabled: busy || !dirty || !name.trim() || conflict || infoDirty && !profileReady, onClick: () => { void commit() }, 'data-dirty': dirty, 'aria-label': t('Save profile') }, t('Save profile')),
    error ? h('p', { className: 'bt-comm-error', role: 'alert' }, error) : null)
}
