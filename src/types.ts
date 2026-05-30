export type StackType = 'rest' | 'spring-boot' | 'spring-batch' | 'ejb' | 'jsf' | 'weblogic'
export type PhaseNumber = 0 | 1 | 2 | 3 | 4 | 5
export type PhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_gate'
  | 'approved'
  | 'completed'
  | 'failed'
  | 'rolled_back'
export type BuildSystem = 'maven' | 'gradle' | 'ant'
export type AppServer = 'weblogic' | 'jboss' | 'tomcat' | 'liberty' | null
export type CiSystem = 'github-actions' | 'jenkins' | 'gitlab-ci' | null
export type RiskSeverity = 'critical' | 'high' | 'medium' | 'low'
export type ManualReviewCategory = 'semantic' | 'security' | 'behavioral' | 'ui'
