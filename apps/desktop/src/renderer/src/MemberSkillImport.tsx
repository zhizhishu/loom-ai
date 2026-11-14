import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { SkillImportCandidate, SkillImportInspection, SkillView, StoredCommandResult } from '@contracts'
import { AppDialogBody, AppDialogContent, AppDialogFooter, AppDialogHeader } from './AppDialog'
import { useThreadClient } from './camp-client'
import { uiAttribute, useUiText } from './interface-language'
import type { CapabilityItem } from './member-catalog-model'

/** Core-owned catalog ids for imported library skills; the library id is never retyped by hand. */
const LIBRARY_PREFIX = 'library:'

type Pending =
  | { step: 'commit', candidateName: string, commandId: string, confirmUpdate: boolean }
  | { step: 'register', candidateName: string, skillId: string | null }

function requestCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code
  return ''
}

/** The committed skill id, from the stored command rather than from a second guess. */
function committedSkillId(result: StoredCommandResult): string | null {
  const payloadId = result.payload && typeof result.payload.skillId === 'string' ? result.payload.skillId : null
  if (payloadId) return payloadId
  return result.resultEntity?.entityType === 'skill' ? result.resultEntity.entityId : null
}

function commitRefusal(code: string, t: (text: string, ...values: Array<string | number>) => string): string {
  if (code === 'skill_update_confirmation_required') return t('同名技能内容不同，要用「确认更新并加入目录」。')
  if (code === 'version_conflict') return t('同名技能刚被改过。重新检查后再确认。')
  if (code === 'official_skill_name_conflict') return t('这个名字属于 Rovai 内置技能，导入不能覆盖。')
  if (code === 'skill_deleting') return t('同名技能正在删除，暂时不能更新。')
  if (code === 'skill_missing') return t('要更新的技能已经不在了。重新检查后会按新导入处理。')
  return t('没有导入成功。重新检查后再试。')
}

function registrationRefusal(code: string, t: (text: string, ...values: Array<string | number>) => string): string {
  if (code === 'capability.invalid_request') return t('这个技能现在不能加进目录：它可能已停用或正在删除。')
  return t('加入目录没有写成。可以按「重试登记」再试，不会重复导入。')
}

function importActionHint(candidate: SkillImportCandidate, t: (text: string, ...values: Array<string | number>) => string): string {
  if (candidate.importAction === 'create') return t('库里还没有同名技能，会新导入一份。')
  if (candidate.importAction === 'update') return t('库里已有同名技能但内容不同，按这个按钮才会覆盖它。')
  if (candidate.importAction === 'unchanged') return t('库里已有同名技能，内容一样。只是还没加进目录。')
  return t('与内置技能同名，导入不能覆盖。')
}

/**
 * Import one Skill from a folder this Core can read, then register it for the member catalog.
 * Inspection is reversible. The commit is one explicit click per candidate; a failed
 * registration retries only the catalog write, never the import command.
 */
export function MemberSkillImport({
  items,
  onImported,
  onClose
}: {
  items: readonly CapabilityItem[]
  onImported(): void
  onClose(): void
}): React.JSX.Element {
  const client = useThreadClient()
  const t = useUiText()
  const [path, setPath] = useState('')
  const [inspection, setInspection] = useState<SkillImportInspection | null>(null)
  const [library, setLibrary] = useState<readonly SkillView[]>([])
  const [busy, setBusy] = useState<'inspect' | 'commit' | 'register' | 'library' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [importedNames, setImportedNames] = useState<readonly string[]>([])
  const [registeredIds, setRegisteredIds] = useState<readonly string[]>([])
  // One generation fences every late reply: closing the dialog or a new step lands nowhere.
  const generation = useRef(0)

  function retire(): number {
    generation.current += 1
    return generation.current
  }

  function alive(token: number): boolean {
    return generation.current === token
  }

  /** A commit whose outcome never came back owns the next decision: it is replayed, never replaced. */
  function unresolvedCommit(): boolean {
    return pending !== null && pending.step === 'commit'
  }

  function loadLibrary(): void {
    const token = generation.current
    void client.request<SkillView[]>('skills.list').then((skills) => {
      if (!alive(token)) return
      setLibrary(skills)
    }).catch(() => {
      if (!alive(token)) return
      setError(uiAttribute('库列表没有读到。导入仍可继续，稍后重开这里再看。'))
    })
  }

  useEffect(() => {
    // Only the live dialog may publish the library read.
    loadLibrary()
    return () => { generation.current += 1 }
  }, [client])

  function inspect(): void {
    const target = path.trim()
    if (!target) {
      setError(t('先填写这份 Core 能读到的文件夹路径。'))
      return
    }
    if (unresolvedCommit()) {
      setError(t('先把上一次导入的结果核对完：按「重试导入」再继续。'))
      return
    }
    const token = retire()
    setBusy('inspect')
    setError('')
    setNotice('')
    setPending(null)
    setInspection(null)
    void client.request<SkillImportInspection>('skills.import.inspect', { path: target }).then((next) => {
      if (!alive(token)) return
      setBusy(null)
      setInspection(next)
      if (!next.candidates.length) setNotice(t('这个文件夹里没有找到 Skill。'))
    }).catch(() => {
      if (!alive(token)) return
      setBusy(null)
      setError(t('检查没有完成。路径要写这份 Core 能读到的文件夹，再试一次。'))
    })
  }

  async function register(candidateName: string, knownSkillId: string | null, token: number): Promise<void> {
    setBusy('register')
    setError('')
    try {
      let skillId = knownSkillId
      if (!skillId) {
        const skills = await client.request<SkillView[]>('skills.list')
        if (!alive(token)) return
        const matches = skills.filter((skill) => skill.name === candidateName && skill.origin === 'imported')
        if (matches.length !== 1) {
          setPending({ step: 'register', candidateName, skillId: null })
          setError(t('库里同名「{0}」的导入技能有 {1} 个，没有登记。重新检查后再确认。', candidateName, String(matches.length)))
          return
        }
        skillId = matches[0].id
      }
      const target = skillId
      await client.request<{ id: string }>('members.capabilityCatalog.putItem', {
        kind: 'skill',
        itemId: `${LIBRARY_PREFIX}${target}`,
        toolNames: []
      })
      if (!alive(token)) return
      setRegisteredIds((current) => [...current, target])
      setImportedNames((current) => [...current, candidateName])
      setPending(null)
      setNotice(t('已加进目录。回到目录勾上它，才会进下一次运行包。'))
      onImported()
      loadLibrary()
    } catch (failure: unknown) {
      if (!alive(token)) return
      setPending({ step: 'register', candidateName, skillId: knownSkillId })
      setError(registrationRefusal(requestCode(failure), t))
    } finally {
      if (alive(token)) setBusy(null)
    }
  }

  function commit(candidate: SkillImportCandidate, confirmUpdate: boolean): void {
    if (!inspection) return
    if (importedNames.includes(candidate.name)) {
      setError(t('这个技能已经加进目录了，不用再导入一次。'))
      return
    }
    if (pending && pending.step === 'commit'
      && (pending.candidateName !== candidate.name || pending.confirmUpdate !== confirmUpdate)) {
      setError(t('上一次导入的结果还没核对完，先按「重试导入」核对完这一条。'))
      return
    }
    const reuse = pending && pending.step === 'commit' && pending.candidateName === candidate.name
      && pending.confirmUpdate === confirmUpdate
      ? pending.commandId
      : crypto.randomUUID()
    const token = retire()
    setBusy('commit')
    setError('')
    setNotice('')
    // The same command id is kept for a retry, so an unknown outcome is replayed, never re-imported.
    const directive: Pending = { step: 'commit', candidateName: candidate.name, commandId: reuse, confirmUpdate }
    setPending(directive)
    void client.request<StoredCommandResult>('skills.import.commit', {
      commandId: reuse,
      command: {
        stagingToken: inspection.stagingToken,
        candidateName: candidate.name,
        expectedDigest: candidate.contentDigest,
        expectedSkillVersion: candidate.existingSkillVersion,
        confirmUpdate
      }
    }).then((result) => {
      if (!alive(token)) return
      if (result.status !== 'applied') {
        setPending(null)
        setBusy(null)
        setError(commitRefusal(result.code, t))
        return
      }
      const skillId = committedSkillId(result)
      setPending({ step: 'register', candidateName: candidate.name, skillId })
      void register(candidate.name, skillId, token)
    }).catch(() => {
      if (!alive(token)) return
      setBusy(null)
      setError(t('导入结果没有回来。可以按「重试导入」，用同一次请求再核对，不会重复导入。'))
    })
  }

  function addExisting(skill: SkillView): void {
    if (unresolvedCommit()) {
      setError(t('先把上一次导入的结果核对完：按「重试导入」再继续。'))
      return
    }
    const token = retire()
    setBusy('library')
    setError('')
    setNotice('')
    void client.request<{ id: string }>('members.capabilityCatalog.putItem', {
      kind: 'skill',
      itemId: `${LIBRARY_PREFIX}${skill.id}`,
      toolNames: []
    }).then(() => {
      if (!alive(token)) return
      setRegisteredIds((current) => [...current, skill.id])
      setBusy(null)
      setNotice(t('已加进目录。回到目录勾上它，才会进下一次运行包。'))
      onImported()
    }).catch((failure: unknown) => {
      if (!alive(token)) return
      setBusy(null)
      setError(registrationRefusal(requestCode(failure), t))
    })
  }

  function retry(): void {
    if (!pending) return
    if (pending.step === 'commit') {
      const candidate = inspection?.candidates.find((entry) => entry.name === pending.candidateName)
      if (!candidate) {
        setPending(null)
        setError(t('这次检查已经不能用了，重新检查后再试。'))
        return
      }
      commit(candidate, pending.confirmUpdate)
      return
    }
    void register(pending.candidateName, pending.skillId, retire())
  }

  const candidates = inspection?.candidates ?? []
  // While one commit's outcome is unknown, only that candidate's replay may act.
  const lockedCandidate = pending !== null && pending.step === 'commit' ? pending.candidateName : null
  const libraryRows = library.filter((skill) => skill.origin === 'imported'
    && skill.lifecycleStatus === 'active'
    && skill.enabled
    && !registeredIds.includes(skill.id)
    && !items.some((item) => item.kind === 'skill' && item.id === `${LIBRARY_PREFIX}${skill.id}`))

  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay app-dialog-overlay" />
      <AppDialogContent width="wide" aria-describedby="member-skill-import-description">
        <AppDialogHeader
          title={t('导入 Skill')}
          description={t('填写这份 Core 可读取的文件夹。检查只读目录，导入要你按下面每个候选的按钮。')}
          descriptionId="member-skill-import-description"
        />
        <AppDialogBody>
          <label className="field-label" htmlFor="member-skill-import-path">
            {t('Core 上的文件夹路径')}
            <input
              id="member-skill-import-path"
              type="text"
              value={path}
              data-dialog-autofocus
              placeholder={t('填写这份 Core 可读取的文件夹')}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <button className="primary-button" type="button" disabled={busy !== null || lockedCandidate !== null || !path.trim()} onClick={inspect}>
              {busy === 'inspect' ? t('正在检查…') : t('检查')}
            </button>
          </div>
          {error && <p className="member-catalog-banner is-error" role="alert">{error}</p>}
          {!error && notice && <p className="member-catalog-banner" role="status">{notice}</p>}
          {inspection && <div className="member-catalog-groups">
            <section className="member-catalog-group" aria-label={t('检查结果')}>
              <h3>{t('检查结果')}</h3>
              <p className="member-catalog-source">{inspection.sourcePath}</p>
              <p className="member-catalog-hint">{t('检查结果到 {0} 为止有效，过期要重新检查。', new Date(inspection.expiresAt).toLocaleString())}</p>
            </section>
            {candidates.map((candidate) => {
              const done = importedNames.includes(candidate.name)
              const conflict = candidate.importAction === 'official_conflict'
              const label = candidate.importAction === 'create'
                ? t('导入并加入目录')
                : candidate.importAction === 'update' ? t('确认更新并加入目录') : t('加入目录')
              const busyHere = (busy === 'commit' || busy === 'register') && pending !== null && pending.candidateName === candidate.name
              return <section key={candidate.name} className="member-catalog-group" aria-label={candidate.name}>
                <h3>{candidate.name}</h3>
                <p className="member-catalog-hint">{candidate.description || t('没有描述')}</p>
                <p className="member-catalog-hint">{importActionHint(candidate, t)}</p>
                <p className="member-catalog-source">{candidate.sourcePath}</p>
                {done
                  ? <p className="member-catalog-hint">{t('已加入目录。')}</p>
                  : conflict
                    ? <p className="member-catalog-hint">{t('这个名字属于 Rovai 内置技能，导入不能覆盖，也不会改名。')}</p>
                    : <div className="dialog-actions">
                      <button
                        className={candidate.importAction === 'update' ? 'primary-button' : 'quiet-button'}
                        type="button"
                        disabled={busy !== null || (lockedCandidate !== null && lockedCandidate !== candidate.name)}
                        onClick={() => candidate.importAction === 'unchanged'
                          ? void register(candidate.name, candidate.existingSkillId, retire())
                          : commit(candidate, candidate.importAction === 'update')}
                      >{busyHere ? t('正在导入…') : label}</button>
                    </div>}
              </section>
            })}
            {inspection.rejectedCandidates.length > 0 && <section className="member-catalog-group" aria-label={t('没有通过检查')}>
              <h3>{t('没有通过检查')}</h3>
              {inspection.rejectedCandidates.map((rejected) => <p key={`${rejected.sourcePath}:${rejected.code}`} className="member-catalog-hint">
                {rejected.sourcePath} · {rejected.code}
              </p>)}
            </section>}
          </div>}
          <div className="member-catalog-groups">
            <section className="member-catalog-group" aria-label={t('库里还没加进目录的 Skill')}>
              <h3>{t('库里还没加进目录的 Skill')}</h3>
              <p className="member-catalog-hint">{t('已经在库里的导入技能可以直接加进目录。加进去不会自动勾上。')}</p>
              {libraryRows.length === 0
                ? <p className="member-catalog-hint">{t('没有待加入的。')}</p>
                : libraryRows.map((skill) => <p key={skill.id} className="member-catalog-source">
                  {skill.name}
                  {' '}
                  <button className="member-catalog-link" type="button" disabled={busy !== null || lockedCandidate !== null} onClick={() => addExisting(skill)}>
                    {t('加入目录')}
                  </button>
                </p>)}
            </section>
          </div>
        </AppDialogBody>
        <AppDialogFooter>
          {pending && busy === null && <button className="quiet-button" type="button" onClick={retry}>
            {pending.step === 'commit' ? t('重试导入') : t('重试登记')}
          </button>}
          <button className="quiet-button" type="button" onClick={onClose}>{t('关闭')}</button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog.Portal>
  </Dialog.Root>
}
