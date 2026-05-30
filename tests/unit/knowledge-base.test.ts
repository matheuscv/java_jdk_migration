import { describe, it, expect } from 'vitest'
import {
  getEntriesForJdk,
  correlate,
  type KnowledgeEntry,
} from '../../src/knowledge-base/index.js'
import type { StaticAnalysisResult } from '../../src/static-analysis/index.js'

describe('getEntriesForJdk', () => {
  it('returns entries for JDK 8 → 21 path', () => {
    const entries = getEntriesForJdk(8, 21)
    expect(entries.length).toBeGreaterThanOrEqual(20)
  })

  it('returns superset for JDK 6 → 21 path', () => {
    const e8 = getEntriesForJdk(8, 21)
    const e6 = getEntriesForJdk(6, 21)
    expect(e6.length).toBeGreaterThanOrEqual(e8.length)
  })

  it('includes sun.misc.BASE64Encoder as high severity', () => {
    const entries = getEntriesForJdk(8, 21)
    const entry = entries.find(e => e.apiPattern === 'sun.misc.BASE64Encoder')
    expect(entry).toBeDefined()
    expect(entry?.severity).toBe('high')
    expect(entry?.removedInJdk).toBe(9)
    expect(entry?.recipe).toBeTruthy()
  })

  it('includes javax.xml.bind as critical', () => {
    const entries = getEntriesForJdk(8, 21)
    const entry = entries.find(e => e.apiPattern === 'javax.xml.bind')
    expect(entry).toBeDefined()
    expect(entry?.severity).toBe('critical')
    expect(entry?.jep).toBe('JEP-320')
  })

  it('includes Thread.stop as high severity', () => {
    const entries = getEntriesForJdk(8, 21)
    const entry = entries.find(e => e.apiPattern.includes('Thread#stop'))
    expect(entry).toBeDefined()
    expect(entry?.severity).toBe('high')
  })

  it('excludes entries removed beyond targetJdk — but targetJdk 21 covers all current entries', () => {
    const entries = getEntriesForJdk(8, 21)
    for (const e of entries) {
      expect(e.removedInJdk).toBeLessThanOrEqual(21)
    }
  })
})

describe('correlate', () => {
  function makeResult(classNames: string[]): StaticAnalysisResult {
    return {
      jdeprscanItems: classNames.map(c => ({
        className: c,
        member: null,
        removedInJdk: null,
        replacement: null,
        file: null,
        line: null,
      })),
      sourceItems: [],
      jdepsViolations: [],
      splitPackages: [],
      runtimeWarnings: [],
      javaHomeUsed: null,
      compiledClassesFound: false,
      analysisTimestamp: new Date().toISOString(),
    }
  }

  it('matches exact class name', () => {
    const result = makeResult(['sun.misc.BASE64Encoder'])
    const issues = correlate(result, 8)
    expect(issues).toHaveLength(1)
    expect(issues[0].apiPattern).toBe('sun.misc.BASE64Encoder')
    expect(issues[0].severity).toBe('high')
    expect(issues[0].automatable).toBe(true)
  })

  it('matches package prefix — javax.xml.bind.JAXBContext → javax.xml.bind entry', () => {
    const result = makeResult(['javax.xml.bind.JAXBContext'])
    const issues = correlate(result, 8)
    expect(issues.length).toBeGreaterThanOrEqual(1)
    const issue = issues.find(i => i.apiPattern === 'javax.xml.bind')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('critical')
  })

  it('returns empty array for unknown class', () => {
    const result = makeResult(['com.example.MyClass'])
    const issues = correlate(result, 8)
    expect(issues).toHaveLength(0)
  })

  it('deduplicates the same API found in multiple files', () => {
    const base: StaticAnalysisResult = {
      jdeprscanItems: [],
      sourceItems: [
        { className: 'sun.misc.BASE64Encoder', member: null, removedInJdk: 9, replacement: null, file: 'A.java', line: 1 },
        { className: 'sun.misc.BASE64Encoder', member: null, removedInJdk: 9, replacement: null, file: 'B.java', line: 3 },
      ],
      jdepsViolations: [],
      splitPackages: [],
      runtimeWarnings: [],
      javaHomeUsed: null,
      compiledClassesFound: false,
      analysisTimestamp: new Date().toISOString(),
    }
    const issues = correlate(base, 8)
    const encoder = issues.find(i => i.apiPattern === 'sun.misc.BASE64Encoder')
    expect(encoder).toBeDefined()
    expect(encoder?.foundInFiles).toHaveLength(2)
    expect(encoder?.foundInFiles).toContain('A.java')
    expect(encoder?.foundInFiles).toContain('B.java')
  })

  it('sorts results by severity — critical before high before medium before low', () => {
    const result = makeResult([
      'sun.misc.BASE64Encoder',    // high
      'javax.xml.bind.JAXBContext', // critical (via prefix)
      'java.util.Observable',      // low
    ])
    const issues = correlate(result, 8)
    const severities = issues.map(i => i.severity)
    const criticalIdx = severities.indexOf('critical')
    const highIdx = severities.findIndex(s => s === 'high')
    const lowIdx = severities.indexOf('low')
    if (criticalIdx !== -1 && highIdx !== -1) {
      expect(criticalIdx).toBeLessThan(highIdx)
    }
    if (highIdx !== -1 && lowIdx !== -1) {
      expect(highIdx).toBeLessThan(lowIdx)
    }
  })
})
