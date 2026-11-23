import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prunePlan, pruneWorkspaces, sessionDirName } from '../src/app/prune.ts'
import type { PruneHost } from '../src/app/prune.ts'

interface Ticket { ended?: Record<string, unknown>; execution?: { directory: string } }

/** A throwaway machine: `<home>/sessions`, `<home>/state/superagent` and its `work` root. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), 'prune-'))
  const stateDir = join(home, 'state', 'superagent')
  const root = join(stateDir, 'work')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(home, 'sessions'))
  const mutable = { tickets: [] as Ticket[] }
  const host = {
    stateDir,
    workspaces: { list: () => [], delete: async (id: unknown) => { void id } },
    store: { tickets: { list: () => mutable.tickets }, settings: () => ({ executor: {} }) },
  } as unknown as PruneHost
  const session = (path: string) => join(home, 'sessions', sessionDirName(path))
  return { home, stateDir, root, host, mutable, session, sessions: () => readdirSync(join(home, 'sessions')).sort() }
}

it('builds the session directory name the way DSH does', () => {
  expect(sessionDirName('C:/Users/zero/.dsh/state/superagent/work/x-402c63d2ca4c'))
    .toBe('--C-Users-zero-.dsh-state-superagent-work-x-402c63d2ca4c--')
  expect(sessionDirName('C:\\Users\\zero')).toBe(sessionDirName('C:/Users/zero'))
  expect(sessionDirName('a b')).toBe('--a~0020b--')
  expect(sessionDirName('')).toBe('--root--')
})

it('moves the session directory of an ended Ticket next to its work directory', async () => {
  const world = machine()
  const directory = join(world.root, 'git-fix-182f03d2cd2b')
  mkdirSync(directory)
  mkdirSync(join(world.session(directory), 'worker-1'), { recursive: true })
  world.mutable.tickets = [{ ended: {}, execution: { directory } }]
  const result = await pruneWorkspaces(world.host)
  expect(result.errors).toEqual([])
  expect(result.removed.map(item => item.name)).toEqual(['git-fix-182f03d2cd2b'])
  expect(world.sessions()).toEqual([])
  expect(existsSync(join(world.stateDir, 'trash'))).toBe(true)
})

it('second pass trashes leftover session directories whose work directory is gone', async () => {
  const world = machine()
  const live = join(world.root, 'live-1aa91c21252e')
  const existing = join(world.root, 'existing-but-unregistered-000000000000')
  const gone = join(world.root, 'gone-402c63d2ca4c')
  mkdirSync(live)
  mkdirSync(existing)
  world.mutable.tickets = [{ execution: { directory: live } }]
  for (const path of [live, existing, gone]) {
    mkdirSync(join(world.session(path), 'worker-1'), { recursive: true })
    writeFileSync(join(world.session(path), 'worker-1', 'session.v4.jsonl'), '{}')
  }
  // Not Ticket directories: the main workspace, another workspace and a test state directory.
  for (const path of [join(world.home, '.dsh-aik'), join(world.stateDir), join(world.stateDir, 'test')]) {
    mkdirSync(world.session(path), { recursive: true })
  }
  const result = await pruneWorkspaces(world.host)
  expect(result.errors).toEqual([])
  expect(result.trashed.map(path => path.split(/[\\/]/).at(-1))).toEqual([sessionDirName(join(world.root, 'gone-402c63d2ca4c'))])
  expect(world.sessions()).toEqual([
    sessionDirName(join(world.home, '.dsh-aik')),
    sessionDirName(live),
    sessionDirName(existing),
    sessionDirName(world.stateDir),
    sessionDirName(join(world.stateDir, 'test')),
  ].sort())
  expect(existsSync(live)).toBe(true)
})

it('deletes an empty leftover session directory instead of trashing it', async () => {
  const world = machine()
  mkdirSync(world.session(join(world.root, 'empty-402c63d2ca4c')), { recursive: true })
  const result = await pruneWorkspaces(world.host)
  expect(result.trashed).toEqual([])
  expect(existsSync(join(world.stateDir, 'trash'))).toBe(false)
  expect(world.sessions()).toEqual([])
})

it('leaves a live Ticket alone in the plan', () => {
  const world = machine()
  const live = join(world.root, 'live-1aa91c21252e')
  const ended = join(world.root, 'ended-402c63d2ca4c')
  mkdirSync(live)
  mkdirSync(ended)
  world.mutable.tickets = [{ execution: { directory: live } }, { ended: {}, execution: { directory: ended } }]
  expect(prunePlan(world.host)).toEqual({ removable: [{ name: 'ended-402c63d2ca4c', path: ended }], kept: [live] })
})
