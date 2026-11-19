import type { AgentProfile, ThreadSnapshot, MissionRecord, LoomTask, LoomCandidate, LoomArtifact, LoomPlan, LoomReview, LoomVerification } from '@contracts'
export type { AgentProfile, ThreadSnapshot, MissionRecord, LoomTask, LoomCandidate, LoomArtifact, LoomPlan, LoomReview, LoomVerification }
export type ConversationItem = { id: string; title: string; subtitle: string; agentId: string | null; threadId: string | null; missionId: string | null; unread: boolean; updatedAt: string | null }
export type WorkItem = { task: LoomTask; mission: MissionRecord; candidate: LoomCandidate | null }
export type WorkBundle = { mission: MissionRecord; plan: LoomPlan | null; tasks: LoomTask[]; candidates: LoomCandidate[]; artifacts: LoomArtifact[]; reviews: LoomReview[]; verifications: LoomVerification[] }
export type ArtifactSelection = { artifact: LoomArtifact; candidate: LoomCandidate | null; bundle: WorkBundle }
export type InspectorTab = 'work' | 'details' | 'capabilities' | 'assets' | 'computer'

export type InspectorMode = 'work' | 'profile' | 'assets' | 'map' | 'computer'
