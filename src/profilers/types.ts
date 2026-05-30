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
