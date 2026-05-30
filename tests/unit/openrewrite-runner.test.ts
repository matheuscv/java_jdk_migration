import { describe, it, expect } from 'vitest'
import { parseMavenWarnings, parseModifiedFilesCount } from '../../src/transform-engine/openrewrite-runner.js'

describe('parseMavenWarnings', () => {
  it('extracts [WARNING] lines', () => {
    const output = [
      '[INFO] Building project',
      '[WARNING] Some deprecation warning',
      '[WARNING] Another warning',
      '[INFO] BUILD SUCCESS',
    ].join('\n')
    const warnings = parseMavenWarnings(output)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('Some deprecation warning')
    expect(warnings[1]).toContain('Another warning')
  })

  it('extracts [ERROR] lines that are not BUILD FAILURE', () => {
    const output = [
      '[ERROR] Recipe application error: ...',
      '[ERROR] BUILD FAILURE',
    ].join('\n')
    const warnings = parseMavenWarnings(output)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Recipe application error')
  })

  it('returns empty array for clean output', () => {
    const output = '[INFO] BUILD SUCCESS\n[INFO] Total time: 2.5 s'
    expect(parseMavenWarnings(output)).toHaveLength(0)
  })

  it('returns empty array for empty string', () => {
    expect(parseMavenWarnings('')).toHaveLength(0)
  })
})

describe('parseModifiedFilesCount', () => {
  it('parses "Changes have been made to N source files"', () => {
    const output = '[INFO] Changes have been made to 3 source files.'
    expect(parseModifiedFilesCount(output)).toBe(3)
  })

  it('parses "Changes would be made to N source files" (dryRun format)', () => {
    const output = '[INFO] Changes would be made to 5 source files.'
    expect(parseModifiedFilesCount(output)).toBe(5)
  })

  it('parses "make changes to N source files" format', () => {
    const output = '[INFO] These recipes would make changes to 2 source files:'
    expect(parseModifiedFilesCount(output)).toBe(2)
  })

  it('returns 0 when no count found', () => {
    expect(parseModifiedFilesCount('[INFO] BUILD SUCCESS')).toBe(0)
    expect(parseModifiedFilesCount('')).toBe(0)
  })

  it('handles singular "source file"', () => {
    const output = '[INFO] Changes have been made to 1 source file.'
    expect(parseModifiedFilesCount(output)).toBe(1)
  })
})
