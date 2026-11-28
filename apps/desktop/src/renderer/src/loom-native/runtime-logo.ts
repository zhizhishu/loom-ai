import type { MemberRuntimeConfiguration } from '@contracts'
import claudeCodeLogo from '../assets/runtime-logos/claudecode-color.svg'
import codexLogo from '../assets/runtime-logos/codex-color.svg'
import deepseekLogo from '../assets/runtime-logos/deepseek-color.svg'
import piLogo from '../assets/runtime-logos/pi.svg'

/**
 * Runtime product logos already shipped for onboarding
 * (`assets/runtime-logos/`, provenance in `ASSET-NOTICE.md`). Reused verbatim so an
 * assistant without a personal avatar shows its execution engine instead of an
 * initial letter. Runtimes with no local asset keep the existing letter fallback.
 */
const RUNTIME_LOGOS: Partial<Record<MemberRuntimeConfiguration['adapterKind'], string>> = {
  'claude-code-cli': claudeCodeLogo,
  'codex-cli': codexLogo,
  'deepseek-harness': deepseekLogo,
  pi: piLogo
}

export function runtimeLogoFor(kind: string | null | undefined): string | null {
  if (!kind) return null
  return RUNTIME_LOGOS[kind as MemberRuntimeConfiguration['adapterKind']] ?? null
}
