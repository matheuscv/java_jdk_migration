export type MigrationErrorCode =
  | 'GATE_TOKEN_INVALID'
  | 'PHASE_OUT_OF_ORDER'
  | 'BUILD_FAILED'
  | 'STACK_NOT_DETECTED'
  | 'OPENREWRITE_NOT_FOUND'
  | 'GIT_DIRTY_WORKDIR'
  | 'GIT_WORKSPACE_INIT_FAILED'
  | 'GRAPH_NOTIFICATION_FAILED'
  | 'CONFIG_NOT_FOUND'
  | 'JAVA_NOT_FOUND'
  | 'LOCK_FILE_EXISTS'
  | 'INVALID_PROJECT_PATH'
  | 'INVALID_GITHUB_REF'
  | 'GITHUB_CREDENTIALS_MISSING'
  | 'GITHUB_CLONE_FAILED'

export class MigrationError extends Error {
  readonly code: MigrationErrorCode
  readonly details: unknown

  constructor(code: MigrationErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
    this.details = details
    // necessário para instanceof funcionar corretamente com subclasses de Error no ES2022
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
