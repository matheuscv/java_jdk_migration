import type { StackType, PhaseNumber, RiskSeverity, ManualReviewCategory } from '../types.js'
import type { JdkMigrationConfig } from '../lib/config.js'

export interface RiskItem {
  id: string
  severity: RiskSeverity
  title: string
  description: string
  file: string | null
  line: number | null
  automationAvailable: boolean
  recipe: string | null
}

export interface ManualReviewItem {
  id: string
  category: ManualReviewCategory
  title: string
  description: string
  suggestedApproach: string
  files: string[]
  /** True when only a human can make this decision (architectural, policy, compliance). */
  requiresHumanDecision?: boolean
  /** True when Claude Code can research/verify this item (e.g. check a registry, scan files). */
  claudeCanResearch?: boolean
  /** Options presented to the human when requiresHumanDecision is true. */
  decisionOptions?: string[]
}

export interface PrerequisiteCheck {
  name: string
  passed: boolean
  message: string
}

export interface ProfilerReport {
  stackType: StackType
  riskItems: RiskItem[]
  manualReviewItems: ManualReviewItem[]
  estimatedEffortDays: number
  prerequisiteChecks: PrerequisiteCheck[]
}

export interface StackProfiler {
  readonly stackType: StackType
  analyze(projectPath: string, config: JdkMigrationConfig): Promise<ProfilerReport>
  getRiskItems(report: ProfilerReport): RiskItem[]
  getRecipes(phase: PhaseNumber, report: ProfilerReport): string[]
  getManualReviewItems(report: ProfilerReport): ManualReviewItem[]
}
