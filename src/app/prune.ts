/** Prunes finished-Ticket residue: work directories, session directories and their workspace registrations. */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, realpathSync } from 'node:fs'
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
/** Result of a prune run (or, for preview routes, of the shared planning step). */
export interface PruneResult {
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
/** DSH session-persistence directory name for a canonical working directory: `--<path with non-alphanumerics dashed>--`. */
const sessionDirName = (path: string): string => `--${path.replace(/[^A-Za-z0-9.]/g, '-')}-`
const under = (child: string, parent: string): boolean => {
  const c = lower(child), p = lower(parent)
  return c !== p && c.startsWith(p.endsWith('\\') ? p : `${p}\\`)
}

/**
 * Plans a prune without touching anything: workspace registrations and work directories under the execution root whose
 * Tickets have all ended (or that no stored Ticket references anymore). Everything else is reported as kept.
 */
export function prunePlan(host: PruneHost): { removable: PruneItem[]; kept: string[] } {
  const { store, stateDir, workspaces } = host
  const settings = store.settings()
  const configured = executionRoot(settings, stateDir)
  let root: string
  try { root = realpathSync(configured) } catch { return { removable: [], kept: [] } }
  const inRoot = (path: string): boolean => under(path, configured) || under(path, root)
  const endedDirectories = new Set(store.tickets.list().filter(ticket => ticket.ended)
    .map(ticket => basename(ticket.execution?.directory ?? '').toLowerCase()))
  const ended = (path: string): boolean => endedDirectories.has(basename(path).toLowerCase())
  const removable: PruneItem[] = [], kept: string[] = []
  const seen = new Set<string>()
  for (const workspace of workspaces.list()) {
    if (!inRoot(workspace.path) || seen.has(lower(workspace.path))) continue
    seen.add(lower(workspace.path))
    const name = basename(workspace.path)
    if (!TICKET_DIR.test(name) || !ended(workspace.path)) { kept.push(workspace.path); continue }
    removable.push({ id: workspace.id, name, path: workspace.path })
  }
  // Residue: work directories whose registration is already gone. A live Ticket keeps its directory.
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (seen.has(lower(path))) continue
    seen.add(lower(path))
    if (!TICKET_DIR.test(entry.name) || !ended(path)) { kept.push(path); continue }
    removable.push({ name: entry.name, path })
  }
  return { removable, kept }
}

/**
 * Runs the plan: deletes each removable workspace registration through the durable registry (so memory and disk agree
 * without a restart), then deletes empty work directories and moves non-empty ones plus their session-persistence
 * directories into `state/trash/<timestamp>/`. Failures are collected per path; later items still run.
 */
export async function pruneWorkspaces(host: PruneHost): Promise<PruneResult> {
  const { removable, kept } = prunePlan(host)
  const result: PruneResult = { removed: [], trashed: [], kept, errors: [] }
  if (!removable.length) return result
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trash = join(host.stateDir, 'trash', stamp)
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
        else { mkdirSync(trash, { recursive: true }); const target = join(trash, item.name); renameSync(item.path, target); result.trashed.push(target) }
      }
      const sessions = join(resolve(host.stateDir, '..', '..', '..'), 'sessions')
      const source = join(sessions, sessionDirName(item.path))
      if (existsSync(source)) {
        mkdirSync(trash, { recursive: true })
        const target = join(trash, sessionDirName(item.name))
        renameSync(source, target); result.trashed.push(target)
      }
      result.removed.push(item)
    } catch (error) { fail(item.path, error) }
  }
  return result
}
