import type { BusinessEnvironment } from './business-environment'
import { desktopThreadClient } from './desktop-camp-client'
import { desktopFilePreviewApi } from './desktop-file-preview-api'
import { nodeApiFromChannel } from './nodes-api'

const unavailable = { ok: false as const, code: 'nodes_unavailable' }
const desktopNodeChannel = () => typeof window === 'undefined' ? undefined : window.rovai?.nodes

export const desktopBusinessEnvironment: BusinessEnvironment = {
  client: desktopThreadClient,
  files: desktopFilePreviewApi,
  nodes: nodeApiFromChannel({
    list: () => desktopNodeChannel()?.list() ?? Promise.resolve(unavailable),
    pair: () => desktopNodeChannel()?.pair() ?? Promise.resolve(unavailable),
    revoke: nodeId => desktopNodeChannel()?.revoke(nodeId) ?? Promise.resolve(unavailable)
  }),
  get preferences() { return window.rovai },
  get desktop() { return window.rovai },
  selectWorkspaceDirectory: () => window.rovai.selectWorkspaceDirectory(),
  revealProjectDirectory: path => window.rovai.revealProjectDirectory(path)
}
