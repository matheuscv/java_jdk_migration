import type { StackType } from '../types.js'
import type { StackProfiler } from '../profilers/types.js'
import { springBootProfiler } from '../profilers/spring-boot/index.js'
import { springBatchProfiler } from '../profilers/spring-batch/index.js'
import { jakartaProfiler } from '../profilers/jakarta/index.js'
import { restProfiler } from '../profilers/rest/index.js'

const REGISTRY = new Map<StackType, StackProfiler>([
  ['spring-boot', springBootProfiler],
  ['spring-batch', springBatchProfiler],
  ['rest', restProfiler],
])

// Jakarta é transversal — é adicionado implicitamente para qualquer stack
// que use APIs Java EE.
const JAKARTA_STACKS: StackType[] = ['spring-boot', 'ejb', 'jsf', 'rest']

export function getProfilersForStacks(stacks: StackType[]): StackProfiler[] {
  const profilers: StackProfiler[] = []
  const seen = new Set<string>()

  for (const stack of stacks) {
    const profiler = REGISTRY.get(stack)
    if (profiler && !seen.has(stack)) {
      profilers.push(profiler)
      seen.add(stack)
    }
  }

  // Adiciona o profiler Jakarta se a stack usa APIs javax.*
  if (stacks.some(s => JAKARTA_STACKS.includes(s)) && !seen.has('jakarta')) {
    profilers.push(jakartaProfiler)
    seen.add('jakarta')
  }

  return profilers
}
