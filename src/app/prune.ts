/** Prunes finished-Ticket residue: work directories, session directories and their workspace registrations. */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, realpathSync, type Dirent } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { WorkspaceId, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { executionRoot } from './execution-environment.ts'
import type { Store } from './store.ts'

/** Host surface for pruning: the durable workspace registry and the Ticket store. */
export interface PruneHost {
  readonly workspaces: Pick<WorkspaceRegistry, 'list' | 'delete'>
  readonly store: Pick<Store, 'tickets' | 'settings'>
  readonly stateDir: string
}
/** One removable entry: a Ticket work directory and, when registered, its workspace registration. */
export interface PruneItem { id?: string; name: string; path: string }
/** A workspace registration whose directory no longer exists on this machine (for example restored from another machine's backup). */
export interface DeadWorkspace { id: string; name: string; path: string }
/** What a prune would do: finished-Ticket residue, missing directories, and everything left alone. */
export interface PrunePlan {
  removable: PruneItem[]
  dead: DeadWorkspace[]
  kept: string[]
}
/** Result of a prune run (or, for preview routes, of the shared planning step). */
export interface PruneResult extends Omit<PrunePlan, 'removable'> {
  /** Work directories cleaned in this run: registration deleted, directory deleted or trashed, session directory trashed. */
  removed: PruneItem[]
  /** Paths moved into `state/trash/<timestamp>/` (non-empty work directories and session directories). */
  trashed: string[]
  /** Directories left alone (live Tickets, or paths that are not Ticket work directories). */
  kept: string[]
  /** Per-path failures; a failed registration delete is recorded but the file cleanup is still attempted. */
  errors: { path: string; message: string }[]
}

/** A Ticket work directory name ends in the 12-hex Ticket id suffix; anything else under the execution root is not ours. */
const TICKET_DIR = /-[0-9a-f]{12}$/
const lower = (path: string): string => path.toLowerCase()
/**
 * DSH session-persistence directory name for a working directory, the same key DSH's `projectKey` builds: a run of
 * `/`, `\` or `:` becomes one `-`, other unsafe code units become `~XXXX`, leading dashes are dropped and the slug is
 * capped at 251 characters (`--<slug>--`). A per-character replace gives `C--Users-…`, which DSH never creates.
 */
export function sessionDirName(path: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') { if (!separatorRun) readable += '-'; separatorRun = true }
    else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) { readable += ch; separatorRun = false }
    else { readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`; separatorRun = false }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}
/** The DSH `sessions` directory: the nearest ancestor of `stateDir` (up to three levels up) that holds one. */
function sessionsRoot(stateDir: string): string {
  let dir = resolve(stateDir)
  for (let level = 0; level < 4; level++) {
    const candidate = join(dir, 'sessions')
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  return join(resolve(stateDir, '..', '..'), 'sessions')
}
const under = (child: string, parent: string): boolean => {
  const c = lower(child), p = lower(parent)
  return c !== p && c.startsWith(p.endsWith('\\') ? p : `${p}\\`)
}

/**
 * Plans a prune without touching anything. `removable`: workspace registrations and work directories under the
 * execution root whose Tickets have all ended (or that no stored Ticket references anymore). `dead`: registrations
 * whose directory is missing on this machine and that no live Ticket uses. Everything else is reported as kept.
 */
export function prunePlan(host: PruneHost): PrunePlan {
  const { store, stateDir, workspaces } = host
  const configured = executionRoot(store.settings(), stateDir)
  const liveDirectories = new Set(store.tickets.list().filter(ticket => !ticket.ended)
    .map(ticket => lower(ticket.execution?.directory ?? '')).filter(Boolean))
  const endedDirectories = new Set(store.tickets.list().filter(ticket => ticket.ended)
    .map(ticket => basename(ticket.execution?.directory ?? '').toLowerCase()))
  const ended = (path: string): boolean => endedDirectories.has(basename(path).toLowerCase())
  const plan: PrunePlan = { removable: [], dead: [], kept: [] }
  const seen = new Set<string>()
  // The directory of a registration is compared against both spellings of the execution root.
  const root = (() => { try { return realpathSync(configured) } catch { return configured } })()
  for (const workspace of workspaces.list()) {
    if (seen.has(lower(workspace.path))) continue
    seen.add(lower(workspace.path))
    const name = basename(workspace.path)
    // Only the registration is left: the directory is gone, so nothing on disk can be lost by dropping it.
    if (!existsSync(workspace.path)) {
      if (!liveDirectories.has(lower(workspace.path))) plan.dead.push({ id: workspace.id, name, path: workspace.path })
      continue
    }
    const inRoot = under(workspace.path, configured) || under(workspace.path, root)
    if (!inRoot || !TICKET_DIR.test(name) || !ended(workspace.path)) { plan.kept.push(workspace.path); continue }
    plan.removable.push({ id: workspace.id, name, path: workspace.path })
  }
  // Residue: work directories whose registration is already gone. A live Ticket keeps its directory.
  let entries: Dirent[] = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { /* no execution root yet: nothing to scan */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (seen.has(lower(path))) continue
    seen.add(lower(path))
    if (!TICKET_DIR.test(entry.name) || !ended(path)) { plan.kept.push(path); continue }
    plan.removable.push({ name: entry.name, path })
  }
  return plan
}

/**
 * Runs the plan: deletes each removable workspace registration through the durable registry (so memory and disk agree
 * without a restart), then deletes empty work directories and moves non-empty ones plus their session-persistence
 * directories into `state/trash/<timestamp>/`. Failures are collected per path; later items still run.
 */
export async function pruneWorkspaces(host: PruneHost): Promise<PruneResult> {
  const { removable, dead, kept } = prunePlan(host)
  const result: PruneResult = { removed: [], dead: [], trashed: [], kept, errors: [] }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trash = join(host.stateDir, 'trash', stamp)
  const sessions = sessionsRoot(host.stateDir)
  const toTrash = (source: string, target: string): void => {
    mkdirSync(trash, { recursive: true })
    renameSync(source, target)
    result.trashed.push(target)
  }
  const fail = (path: string, error: unknown): void => {
    result.errors.push({ path, message: error instanceof Error ? error.message : String(error) })
  }
  for (const item of removable) {
    try {
      // Unknown ids are an idempotent no-op for domain callers (`WorkspaceRegistry.delete`).
      if (item.id) await host.workspaces.delete(item.id as WorkspaceId)
    } catch (error) { fail(item.path, error) }
    try {
      if (existsSync(item.path)) {
        if (readdirSync(item.path).length === 0) rmSync(item.path, { recursive: true })
        else toTrash(item.path, join(trash, item.name))
      }
      const source = join(sessions, sessionDirName(item.path))
      if (existsSync(source)) toTrash(source, join(trash, sessionDirName(item.name)))
      result.removed.push(item)
    } catch (error) { fail(item.path, error) }
  }
  // Dead registrations: delete the registration, then trash whatever session records the missing directory left behind.
  for (const item of dead) {
    try { await host.workspaces.delete(item.id as WorkspaceId) } catch (error) { fail(item.path, error); continue }
    try {
      const source = join(sessions, sessionDirName(item.path))
      if (existsSync(source)) {
        if (readdirSync(source).length === 0) rmSync(source, { recursive: true })
        else toTrash(source, join(trash, sessionDirName(item.path)))
      }
      result.dead.push(item)
    } catch (error) { fail(item.path, error) }
  }
  // Second pass: session directories of Ticket work directories that are already gone. An earlier prune (or a run
  // whose session move failed) leaves them behind; nothing lists them, so they are found by their encoded root.
  let root = resolve(executionRoot(host.store.settings(), host.stateDir))
  try { root = realpathSync(root) } catch { /* keep the configured path */ }
  const prefix = sessionDirName(root).slice(0, -1)
  const keptDirectories = new Set(host.store.tickets.list().filter(ticket => !ticket.ended)
    .map(ticket => basename(ticket.execution?.directory ?? '').toLowerCase()).filter(Boolean))
  let names: string[] = []
  try { names = readdirSync(sessions) } catch { /* no sessions directory: nothing left behind */ }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('--')) continue
    const directory = name.slice(prefix.length, -2)
    if (!TICKET_DIR.test(directory) || keptDirectories.has(directory.toLowerCase()) || existsSync(join(root, directory))) continue
    try {
      const path = join(sessions, name)
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true })
      else toTrash(path, join(trash, name))
    } catch (error) { fail(join(sessions, name), error) }
  }
  return result
}
