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
  const registrations = new Map<string, string>()
  const register = (id: string, path: string): void => { registrations.set(id, path) }
  const deleted: string[] = []
  const host = {
    stateDir,
    workspaces: {
      list: () => [...registrations].map(([id, path]) => ({ id, path })),
      delete: async (id: string) => { deleted.push(id); return registrations.delete(id) },
    },
    store: { tickets: { list: () => mutable.tickets }, settings: () => ({ executor: {} }) },
  } as unknown as PruneHost
  const session = (path: string) => join(home, 'sessions', sessionDirName(path))
  return { home, stateDir, root, host, mutable, register, deleted, session, sessions: () => readdirSync(join(home, 'sessions')).sort() }
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
  expect(prunePlan(world.host)).toEqual({ removable: [{ name: 'ended-402c63d2ca4c', path: ended }], dead: [], kept: [live] })
})

it('drops registrations whose directory is missing and trashes the session records they left', async () => {
  const world = machine()
  const other = join(world.home, 'restored', 'audio-lr-balance-3588-ce620d64dc26')
  const empty = join(world.home, 'restored', 'empty-000000000000')
  world.register('dead-1', other)
  world.register('dead-2', empty)
  world.register('live', world.root)
  mkdirSync(join(world.session(other), 'worker-1'), { recursive: true })
  writeFileSync(join(world.session(other), 'worker-1', 'session.v4.jsonl'), '{}')
  mkdirSync(world.session(empty), { recursive: true })
  const plan = prunePlan(world.host)
  expect(plan.dead).toEqual([{ id: 'dead-1', name: 'audio-lr-balance-3588-ce620d64dc26', path: other },
    { id: 'dead-2', name: 'empty-000000000000', path: empty }])
  const result = await pruneWorkspaces(world.host)
  expect(result.errors).toEqual([])
  expect(result.dead.map(item => item.id)).toEqual(['dead-1', 'dead-2'])
  expect(world.deleted).toEqual(['dead-1', 'dead-2'])
  expect(world.sessions()).toEqual([])
  expect(readdirSync(join(world.stateDir, 'trash')).length).toBe(1)
})

it('keeps a missing registration that a live Ticket still points at', () => {
  const world = machine()
  const gone = join(world.root, 'gone-1aa91c21252e')
  world.register('live', gone)
  world.mutable.tickets = [{ execution: { directory: gone } }]
  expect(prunePlan(world.host)).toEqual({ removable: [], dead: [], kept: [] })
})

it('reports a failed registration delete and leaves its session records alone', async () => {
  const world = machine()
  const other = join(world.home, 'restored', 'audio-lr-balance-3588-ce620d64dc26')
  world.register('dead-1', other)
  mkdirSync(join(world.session(other), 'worker-1'), { recursive: true })
  world.host.workspaces.delete = async () => { throw new Error('registry locked') }
  const result = await pruneWorkspaces(world.host)
  expect(result.dead).toEqual([])
  expect(result.errors).toEqual([{ path: other, message: 'registry locked' }])
  expect(world.sessions()).toEqual([sessionDirName(other)])
})
