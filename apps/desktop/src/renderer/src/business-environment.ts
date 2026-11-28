import type { RovaiApi } from '@contracts'
import type { ThreadClient } from './camp-client'
import type { FilePreviewApi } from '@contracts'
import type { NodeApi } from './nodes-api'

/** Cloud person declared by the Host's web boundary (simulated tenancy). */
export interface CloudUser {
  id: string
  displayName: string
  role: string
}

/** Host-owned cloud people access. Only the Web adapter supplies it; Desktop stays single-user. */
export interface CloudPeopleApi {
  /** The signed-in cloud identity; null on single-user Hosts. */
  readonly current: CloudUser | null
  users(): Promise<CloudUser[]>
  campMembers(campId: string): Promise<string[]>
  addCampMember(campId: string, userId: string): Promise<string[]>
}

/** Only dependencies the production business shell uses; never a replacement window.rovai. */
export interface BusinessEnvironment {
  /** Authenticated optional Host providers; never simulated when absent. */
  workbench?: import('./loom-native/host-services').HostWorkbench
  /** Web boundary simulated tenancy; the Host stays the sole authority. */
  cloudPeople?: CloudPeopleApi
  navigationHistory?: import('./desktop-navigation').NavigationHistory
  client: ThreadClient
  files: FilePreviewApi
  preferences: Pick<RovaiApi, 'appearance' | 'generalPreferences' | 'navigationPreferences'>
  selectWorkspaceDirectory: RovaiApi['selectWorkspaceDirectory']
  nodes: NodeApi
  revealProjectDirectory?: RovaiApi['revealProjectDirectory']
  serverUpdates?: RovaiApi['appUpdates']
  /** Native startup, updates, lifecycle and notification integration are absent on Web. */
  desktop?: Pick<RovaiApi, 'desktopSession' | 'onboarding' | 'appLifecycle' | 'userAutomation' | 'appUpdates' | 'exportDiagnostics' | 'windowControls' | 'windowClose' | 'hostWeb' | 'remoteHost'>
}
