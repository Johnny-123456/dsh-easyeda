import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join as joinPath } from 'node:path'

import { EdaCliError, createCli, resolveSession } from './lib/cli.js'
import { ANALYZE, DRAW, EXPORT, LAYOUT, LOCATE, PCB, PROJECT_INFO, SCH_EDIT, SCH_MODULE, SCH_NET } from './lib/scripts.js'

export const name = 'dsh-easyeda'
export const inject = ['tools']

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const schema = (properties, required = []) => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
})

const SESSION = {
  type: 'string',
  description: 'Editor session id from eda_status. Omit when exactly one editor window is open.',
}
const LIMIT = { type: 'integer', description: 'Maximum items to list in the result (default per tool).' }

/** Report a plugin-side CLI failure with its code kept in the message. */
function describe(error) {
  if (error instanceof EdaCliError) return new Error(`${error.code}: ${error.message}`)
  return error
}

/** Where the module name → members mapping lives, beside the project file. */
const projectCache = new Map()

/** Project identity from the editor, cached briefly per session. */
async function projectInfoOf(cli, sessionId) {
  const cached = projectCache.get(sessionId)
  if (cached !== undefined && Date.now() - cached.at < 120_000) return cached.info
  const info = await cli.invoke({ sessionId, code: PROJECT_INFO, args: {}, timeoutMs: 60_000 })
  projectCache.set(sessionId, { info, at: Date.now() })
  return info
}

/**
 * Candidate project files, built from the client's project roots and the project name.
 * A GUI window reports no path and an empty project-root list, but for a personal
 * project `teamUuid` carries the projects directory, so it is used as a root too.
 */
function candidateProjectPaths(info) {
  const roots = Array.isArray(info?.projectsPaths) ? [...info.projectsPaths] : []
  const teamRoot = typeof info?.teamUuid === 'string' && /^([A-Za-z]:[\\/]|\\\\|\/)/.test(info.teamUuid) ? info.teamUuid : undefined
  if (teamRoot !== undefined && !roots.includes(teamRoot)) roots.push(teamRoot)
  const base = info?.internalName || info?.friendlyName || ''
  const out = []
  if (!base) return out
  for (const root of roots) {
    const dir = String(root).replaceAll('/', '\\').replace(/\\+$/, '')
    if (dir === '') continue
    out.push(joinPath(dir, `${base}.eprj2`), joinPath(dir, `${base}.eprj`), joinPath(dir, `${base}.eprj3`), joinPath(dir, base))
  }
  return out
}

/**
 * The project file behind a session. A GUI-opened session reports no path, so
 * fall back to the client's own project roots.
 */
async function resolveProjectFile(cli, sessionId, sessionPath) {
  if (typeof sessionPath === 'string' && sessionPath !== '') return sessionPath
  let info
  try {
    info = await projectInfoOf(cli, sessionId)
  } catch {
    return null
  }
  for (const candidate of candidateProjectPaths(info)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Module store location, with a per-project fallback when the file cannot be found. */
async function moduleStoreLocation(cli, session) {
  const file = await resolveProjectFile(cli, session.sessionId, session.path)
  if (file !== null) {
    try {
      if (statSync(file).isDirectory()) return { path: joinPath(file, 'dsh-modules.json'), fallback: false, projectFile: file }
    } catch { /* unreachable path, use the sidecar name */ }
    return { path: `${file}.dsh-modules.json`, fallback: false, projectFile: file }
  }
  let projectId = 'unknown'
  try {
    projectId = (await projectInfoOf(cli, session.sessionId)).projectId ?? 'unknown'
  } catch { /* keep the generic key */ }
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || process.env.TEMP || '.'
  return { path: joinPath(base, 'dsh-easyeda', 'modules', `${projectId}.json`), fallback: true, projectFile: null }
}

/** Read the module store, tolerating a missing or unreadable file. */
async function readModuleStore(path) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed && Array.isArray(parsed.modules)) return parsed
  } catch { /* first run, or the file is unreadable */ }
  return { version: 1, modules: [] }
}

async function writeModuleStore(path, store) {
  store.version = 1
  store.updatedAt = new Date().toISOString()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(store, null, 2), 'utf8')
}

/** Resolve the session, run the script, and shape the envelope value. */
async function run(ctx, args, script, scriptArgs, timeoutMs) {
  const cli = ctx.cli
  try {
    const session = await resolveSession(cli, args.session, ctx.config)
    const value = await cli.invoke({ sessionId: session.sessionId, code: script, args: scriptArgs, timeoutMs })
    const project = session.path ?? (await resolveProjectFile(cli, session.sessionId, null)) ?? undefined
    return { ...value, session: { id: session.sessionId, project, title: session.title } }
  } catch (error) {
    throw describe(error)
  }
}

export function apply(ctx, config = {}) {
  const cli = createCli(config)
  const scope = { cli, config }

  ctx.tools.register({
    name: 'eda_status',
    description:
      'Check the EasyEDA Pro (JLCEDA) client: bridge connectivity, client version, and the editor sessions that are open. '
      + 'With project, opens that .eprj/.eprj2/.eprj3 file so later commands have a session. '
      + 'Run this first when another EasyEDA command reports no session.',
    parameters: schema({
      project: { type: 'string', description: 'Absolute path of a project file to open. Omit to only report status.' },
      headless: { type: 'boolean', description: 'Open the project without a visible window. Default true.' },
      close: { type: 'string', description: 'Session id to close after reporting.' },
    }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const result = { executable: cli.executable, bridge: null, sessions: [], opened: null, closed: null }
      try {
        result.bridge = await cli.doctor()
      } catch (error) {
        result.bridge = { connected: false, error: error.message, code: error.code }
      }
      try {
        result.sessions = (await cli.listSessions()) ?? []
      } catch (error) {
        result.sessionsError = error.message
      }
      if (typeof args.close === 'string' && args.close !== '') {
        result.closed = await cli.closeSession(args.close).catch((error) => ({ ok: false, message: describe(error).message }))
        result.sessions = (await cli.listSessions().catch(() => [])) ?? []
      }
      if (typeof args.project === 'string' && args.project !== '') {
        result.opened = await cli.openProject(args.project, args.headless !== false)
        result.sessions = (await cli.listSessions().catch(() => [])) ?? []
      }
      if (result.sessions.length > 0) {
        result.sessions = result.sessions.map((s) => ({
          sessionId: s.sessionId,
          status: s.status,
          headless: s.headless,
          origin: s.origin,
          path: s.path,
          title: s.title,
        }))
      }
      // A window the user opened reports no path; ask the editor where its project really is.
      for (const session of result.sessions) {
        if (session.status !== 'alive' || session.path) continue
        try {
          const info = await projectInfoOf(cli, session.sessionId)
          session.project = { id: info.projectId, name: info.friendlyName ?? info.internalName }
          session.resolvedPath = await resolveProjectFile(cli, session.sessionId, null)
        } catch (error) {
          session.project = { error: describe(error).message }
        }
      }
      return result
    },
  })

  ctx.tools.register({
    name: 'eda_schematic',
    description:
      'Analyze the whole schematic in one pass from the project netlist: components with device, value, footprint and supplier part; '
      + 'net count; per-pin connectivity; and the anomalies worth fixing first — nets with a single pin, unconnected pins, components '
      + 'with no footprint, duplicate designators. Filter with query to inspect one part of the design, and set nets to also return the '
      + 'largest nets with their members.',
    parameters: schema({
      query: { type: 'string', description: 'Case-insensitive match over designator, device, value, LCSC or manufacturer part.' },
      nets: { type: 'boolean', description: 'Also return the largest nets and their members. Default false.' },
      netLimit: { type: 'integer', description: 'Nets returned when nets is true. Default 30.' },
      memberLimit: { type: 'integer', description: 'Members listed per net. Default 12; a net with more sets membersTruncated and keeps memberCount at the real total.' },
      limit: { type: 'integer', description: 'Components listed. Default 60; the total count is always reported.' },
      session: SESSION,
    }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      return run(scope, args, ANALYZE, {
        query: args.query,
        nets: args.nets === true,
        netLimit: args.netLimit,
        limit: args.limit,
      })
    },
  })

  ctx.tools.register({
    name: 'eda_locate',
    description:
      'Locate a component on its schematic page and return its page, coordinates, rotation and pin-to-net map. '
      + 'By default it also opens that page, selects the part and zooms to it in the editor, so the answer is visible on screen. '
      + 'Pass designator for one exact part, or query to list parts whose designator or name matches.',
    parameters: schema({
      designator: { type: 'string', description: 'Exact designator such as U1 or C12. Scans pages until it is found.' },
      query: { type: 'string', description: 'Keyword matched against designator and name. Use when the exact designator is unknown.' },
      reveal: { type: 'boolean', description: 'Open the page, select the part and zoom to it. Default true.' },
      scaleRatio: { type: 'integer', description: 'Zoom percentage to apply when revealing, 100 = 100%. Default 250.' },
      limit: { type: 'integer', description: 'Matches listed. Default 20.' },
      session: SESSION,
    }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      return run(scope, args, LOCATE, {
        designator: args.designator,
        query: args.query,
        reveal: args.reveal !== false,
        scaleRatio: args.scaleRatio,
        limit: args.limit,
      })
    },
  })

  ctx.tools.register({
    name: 'eda_sch_edit',
    description:
      'Edit the schematic through the editor source layer: change component properties (value, footprint, supplier part, designator), '
      + 'move or rotate parts, delete parts, swap a part for another device, place new parts from the library, draw wires, and add net '
      + 'labels. Writes land immediately and asynchronously; there is no undo group for a batch, so run it with dryRun first. '
      + 'Each item reports its own result, and a rejected item does not stop the rest.',
    parameters: schema({
      action: { type: 'string', enum: ['set', 'remove', 'replace', 'add', 'wire', 'netlabel'], description: 'Edit operation to run.' },
      edits: {
        type: 'array',
        description: 'For set and replace: one entry per target component, matched by its current designator.',
        items: schema({
          designator: { type: 'string', description: 'Current designator of the component to change.' },
          newDesignator: { type: 'string', description: 'set only: the replacement designator.' },
          properties: { type: 'object', description: 'set only: property keys to overwrite, for example { "Value": "10k", "Footprint": "R0603" }. Values become strings.' },
          x: { type: 'number', description: 'set only: new anchor X in schematic coordinates.' },
          y: { type: 'number', description: 'set only: new anchor Y in schematic coordinates.' },
          rotation: { type: 'number', description: 'set only: new rotation in degrees.' },
          mirror: { type: 'boolean', description: 'set only: mirror the symbol.' },
          lcsc: { type: 'string', description: 'replace only: LCSC part number of the replacement device, for example C1523.' },
          name: { type: 'string', description: 'replace only: device name to search for when no lcsc is given.' },
        }, ['designator']),
      },
      designators: { type: 'array', items: { type: 'string' }, description: 'For remove: designators to delete.' },
      withWires: { type: 'boolean', description: 'For remove: also delete the wires attached to each part. Default false.' },
      devices: {
        type: 'array',
        description: 'For add: parts to place on the target page.',
        items: schema({
          lcsc: { type: 'string', description: 'LCSC part number, for example C1591.' },
          name: { type: 'string', description: 'Device name to search for when no lcsc is given.' },
          x: { type: 'number', description: 'Anchor X in schematic coordinates. This is the anchor, not the body centre.' },
          y: { type: 'number', description: 'Anchor Y in schematic coordinates.' },
          designator: { type: 'string', description: 'Designator to assign. Omit to let the editor allocate one.' },
          rotation: { type: 'number', description: 'Rotation in degrees.' },
          mirror: { type: 'boolean', description: 'Mirror the symbol.' },
          properties: { type: 'object', description: 'Properties to write, for example { "Value": "100nF" }.' },
        }, ['x', 'y']),
      },
      wires: {
        type: 'array',
        description: 'For wire: polylines to add. Endpoints must land on another segment or a pin to connect.',
        items: schema({
          net: { type: 'string', description: 'Net name to propose. The editor keeps an existing name when the wire joins one.' },
          points: {
            type: 'array',
            description: 'Vertices as [x, y] pairs in schematic coordinates, at least two.',
            items: { type: 'array', items: { type: 'number' } },
          },
          schematic: { type: 'string', description: 'Schematic name, when the project has several pages.' },
          page: { type: 'string', description: 'Page name, when the project has several pages.' },
        }, ['points']),
      },
      labels: {
        type: 'array',
        description: 'For netlabel: net labels to add.',
        items: schema({
          net: { type: 'string', description: 'Net name the label carries.' },
          x: { type: 'number', description: 'Label anchor X.' },
          y: { type: 'number', description: 'Label anchor Y.' },
          rotation: { type: 'number', description: 'Rotation in degrees.' },
          mirror: { type: 'boolean', description: 'Mirror the label.' },
          schematic: { type: 'string', description: 'Schematic name, when the project has several pages.' },
          page: { type: 'string', description: 'Page name, when the project has several pages.' },
        }, ['net']),
      },
      schematic: { type: 'string', description: 'Default schematic for add, wire and netlabel.' },
      page: { type: 'string', description: 'Default page for add, wire and netlabel. Required when the project has several pages.' },
      dryRun: { type: 'boolean', description: 'Resolve and report what would change without writing anything.' },
      settleMs: { type: 'integer', description: 'How long to wait for the writes to settle before returning. Default 1200.' },
      session: SESSION,
    }, ['action']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      return run(scope, args, SCH_EDIT, {
        action: args.action,
        edits: args.edits,
        designators: args.designators,
        withWires: args.withWires === true,
        devices: args.devices,
        wires: args.wires,
        labels: args.labels,
        schematic: args.schematic,
        page: args.page,
        dryRun: args.dryRun === true,
        settleMs: args.settleMs,
      }, 180000)
    },
  })

  ctx.tools.register({
    name: 'eda_sch_net',
    description:
      'Move one pin onto another net: set takes designator, pin and net (or several changes). A pin net is carried by the wire under the pin, so this '
      + 'finds the wire at the pin and renames that wire, then reads the wire back to confirm. Use action inspect first to see which wire and which net '
      + 'a pin currently has. action netflag places a power or ground symbol and verifies it really landed there. Renaming a wire moves every pin on '
      + 'that wire, so recheck the net afterwards.',
    parameters: schema({
      action: { type: 'string', enum: ['set', 'inspect', 'netflag'], description: 'set renames the wire under the pin; inspect only reports; netflag places a net symbol. Default set.' },
      designator: { type: 'string', description: 'Component designator for a single change, for example R12.' },
      pin: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Pin number or pin name of that component, for example 2 or VDD.' },
      net: { type: 'string', description: 'Net name the pin should end up on, for example GND.' },
      changes: {
        type: 'array',
        description: 'Several pin changes in one call; each entry overrides the single designator/pin/net arguments.',
        items: schema({
          designator: { type: 'string', description: 'Component designator.' },
          pin: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Pin number or pin name.' },
          net: { type: 'string', description: 'Net name the pin should be on.' },
        }, ['designator', 'pin', 'net']),
      },
      netflag: {
        type: 'object',
        description: 'For action netflag: the symbol to place.',
        properties: {
          type: { type: 'string', enum: ['Power', 'Ground', 'AnalogGround', 'ProtectGround'], description: 'Symbol kind. Power points up, ground symbols point down at rotation 0.' },
          net: { type: 'string', description: 'Net name the symbol carries.' },
          x: { type: 'number', description: 'Anchor X in schematic coordinates.' },
          y: { type: 'number', description: 'Anchor Y in schematic coordinates.' },
          rotation: { type: 'number', description: 'Rotation in degrees. 180 flips the symbol.' },
          mirror: { type: 'boolean', description: 'Mirror the symbol.' },
          page: { type: 'string', description: 'Page to place on, when the project has several pages.' },
        },
      },
      page: { type: 'string', description: 'Page name to search, when the project has several pages.' },
      schematic: { type: 'string', description: 'Schematic name to search, when the project has several pages.' },
      tolerance: { type: 'number', description: 'Coordinate tolerance in schematic units when matching a pin to its wire. Default 1.' },
      dryRun: { type: 'boolean', description: 'Report what would change without writing.' },
      settleMs: { type: 'integer', description: 'How long to wait for the writes to settle. Default 1200.' },
      session: SESSION,
    }, []),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      return run(scope, args, SCH_NET, {
        action: args.action ?? 'set',
        designator: args.designator,
        pin: args.pin,
        net: args.net,
        changes: args.changes,
        netflag: args.netflag,
        page: args.page,
        schematic: args.schematic,
        tolerance: args.tolerance,
        dryRun: args.dryRun === true,
        settleMs: args.settleMs,
      }, 180000)
    },
  })

  ctx.tools.register({
    name: 'eda_sch_module',
    description:
      'Group a schematic block into a named module: draw a border around the chosen parts and write the module name underneath, then find that '
      + 'block again by name. Membership is stored beside the project file, so locate works even when the editor is headless; the border and the '
      + 'name text are drawn only in a visible editor window, and the result says whether that drawing happened. '
      + 'delete removes the whole block, not just its decoration: by default it also deletes the module parts and the wires that belong to them, '
      + 'and keeps any wire that also serves a part outside the module.',
    parameters: schema({
      action: { type: 'string', enum: ['create', 'list', 'locate', 'delete'], description: 'create makes or updates a module; list reports the stored modules; locate selects and zooms to one; delete removes it.' },
      name: { type: 'string', description: 'Module name, for example 电源 or 按键输入.' },
      deleteComponents: { type: 'boolean', description: 'For delete: also remove the module parts, not just its border, name and record. Default true.' },
      wires: { type: 'string', enum: ['module', 'attached', 'none'], description: 'For delete: module removes only wires whose every touching pin is inside the module, attached removes every wire touching a module part, none keeps all wires. Default module.' },
      tolerance: { type: 'number', description: 'For delete: coordinate tolerance in schematic units when matching a pin to a wire. Default 1.' },
      dryRun: { type: 'boolean', description: 'For delete: report what would be removed without changing the schematic.' },
      designators: { type: 'array', items: { type: 'string' }, description: 'Parts that belong to the module. Omit when using region.' },
      region: {
        type: 'object',
        description: 'Area to take members from when designators is omitted; every part anchored inside joins the module.',
        properties: {
          x1: { type: 'number', description: 'First corner X.' },
          y1: { type: 'number', description: 'First corner Y.' },
          x2: { type: 'number', description: 'Opposite corner X.' },
          y2: { type: 'number', description: 'Opposite corner Y.' },
        },
      },
      margin: { type: 'number', description: 'Padding around the parts\' real body boxes, in schematic units (0.01 inch). Default 30 (0.3 inch).' },
      prefix: { type: 'string', description: 'Text written before the name. Default 模块：' },
      fontSize: { type: 'number', description: 'Name text size in schematic units. Default 28.' },
      snap: { type: 'boolean', description: 'Extend the new border until it abuts a neighbouring module border. Default true.' },
      snapGap: { type: 'number', description: 'Largest gap, in schematic units, that snap closes. Default 300.' },
      labelPlacement: { type: 'string', enum: ['inside', 'below'], description: 'Where the name goes: inside reserves a strip at the bottom of the border, below writes it under the border. Default inside.' },
      labelBand: { type: 'number', description: 'Height reserved inside the border for the name. Defaults to about two times the font size.' },
      labelGap: { type: 'number', description: 'Distance between the border bottom and the name, for labelPlacement below. Default 60.' },
      draw: { type: 'boolean', description: 'Draw the border and the name. Default true.' },
      reveal: { type: 'boolean', description: 'For locate: select the members and zoom to the block. Default true.' },
      page: { type: 'string', description: 'Page that holds the block, when the project has several pages.' },
      schematic: { type: 'string', description: 'Schematic that holds the block.' },
      session: SESSION,
    }, ['action']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const action = args.action ?? 'create'
      let session
      try {
        session = await resolveSession(cli, args.session, config)
      } catch (error) {
        throw describe(error)
      }
      const location = await moduleStoreLocation(cli, session)
      const storeFile = location.path
      if (location.fallback) await mkdir(dirname(storeFile), { recursive: true })
      const store = await readModuleStore(storeFile)
      const storeInfo = { storeFile, storeFallback: location.fallback, projectFile: location.projectFile }
      const invokeModule = (scriptArgs) => cli.invoke({
        sessionId: session.sessionId,
        code: SCH_MODULE,
        args: scriptArgs,
        timeoutMs: 180000,
      })

      if (action === 'create') {
        if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('Pass name for the module.')
        const previous = (store.modules ?? []).find((m) => m.name === args.name.trim())
        const neighbors = (store.modules ?? [])
          .filter((m) => String(m.name) !== args.name.trim() && m.bbox)
          .filter((m) => (args.page ? m.page === args.page : true))
          .map((m) => ({ name: m.name, bbox: m.bbox }))
        let value
        try {
          value = await invokeModule({
            action: 'create',
            name: args.name.trim(),
            designators: args.designators,
            region: args.region,
            margin: args.margin,
            prefix: args.prefix,
            fontSize: args.fontSize,
            labelGap: args.labelGap,
            labelPlacement: args.labelPlacement,
            labelBand: args.labelBand,
            snap: args.snap !== false,
            snapGap: args.snapGap,
            neighbors: neighbors,
            draw: args.draw !== false,
            page: args.page,
            schematic: args.schematic,
          })
        } catch (error) {
          throw describe(error)
        }
        const record = {
          name: value.name,
          page: value.page,
          schematic: args.schematic,
          members: value.members,
          bbox: value.bbox,
          textId: value.textId ?? null,
          rectId: value.rectId ?? null,
          drawn: value.drawn === true,
          labelPlacement: value.labelPlacement ?? null,
          labelBand: value.labelBand ?? null,
          updatedAt: new Date().toISOString(),
        }
        if (previous && (previous.textId || previous.rectId) && record.drawn) {
          try {
            await invokeModule({
              action: 'delete',
              deleteComponents: false,
              wires: 'none',
              textIds: previous.textId ? [previous.textId] : [],
              rectIds: previous.rectId ? [previous.rectId] : [],
              page: previous.page,
              schematic: previous.schematic,
            })
          } catch { /* the old decoration may already be gone */ }
        }
        store.modules = (store.modules ?? []).filter((m) => m.name !== record.name)
        store.modules.push(record)
        store.projectId = value.projectId ?? store.projectId
        await writeModuleStore(storeFile, store)
        return { ...value, ...storeInfo, moduleCount: store.modules.length }
      }

      if (action === 'list') {
        if ((store.modules ?? []).length === 0) {
          return { action, ...storeInfo, modules: [], note: 'No module is recorded yet: create one with eda_sch_module.' }
        }
        let value
        try {
          value = await invokeModule({
            action: 'measure',
            modules: store.modules.map((m) => ({ name: m.name, members: m.members, labelPlacement: m.labelPlacement, labelBand: m.labelBand })),
            margin: args.margin,
            page: args.page,
            schematic: args.schematic,
          })
        } catch (error) {
          throw describe(error)
        }
        return {
          action,
          ...storeInfo,
          page: value.page,
          componentCount: value.componentCount,
          modules: value.modules.map((m) => {
            const saved = store.modules.find((s) => s.name === m.name) ?? {}
            return {
              name: m.name,
              members: m.members,
              missing: m.missing,
              bbox: m.bbox,
              drawn: saved.drawn === true,
              updatedAt: saved.updatedAt,
            }
          }),
        }
      }

      if (action === 'locate') {
        if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('Pass name for the module to locate.')
        const record = (store.modules ?? []).find((m) => String(m.name).toLowerCase() === args.name.trim().toLowerCase())
        if (record === undefined) {
          const known = (store.modules ?? []).map((m) => m.name)
          throw new Error(`No module named "${args.name}". Known modules: ${known.length > 0 ? known.join(', ') : '(none)'}`)
        }
        try {
          const value = await invokeModule({
            action: 'locate',
            name: record.name,
            designators: record.members,
            reveal: args.reveal !== false,
            margin: args.margin,
            labelPlacement: record.labelPlacement ?? 'inside',
            labelBand: record.labelBand ?? undefined,
            page: args.page ?? record.page,
            schematic: args.schematic ?? record.schematic,
          })
          if (value.bbox) record.bbox = value.bbox
          await writeModuleStore(storeFile, store)
          return { ...value, ...storeInfo }
        } catch (error) {
          throw describe(error)
        }
      }

      if (action === 'delete') {
        if (typeof args.name !== 'string' || args.name.trim() === '') throw new Error('Pass name for the module to delete.')
        const record = (store.modules ?? []).find((m) => String(m.name).toLowerCase() === args.name.trim().toLowerCase())
        if (record === undefined) throw new Error(`No module named "${args.name}".`)
        const dryRun = args.dryRun === true
        const wires = args.wires ?? 'module'
        const deleteComponents = args.deleteComponents !== false
        let value
        try {
          value = await invokeModule({
            action: 'delete',
            designators: record.members ?? [],
            deleteComponents,
            wires,
            dryRun,
            textIds: !dryRun && record.textId ? [record.textId] : [],
            rectIds: !dryRun && record.rectId ? [record.rectId] : [],
            tolerance: args.tolerance,
            page: args.page ?? record.page,
            schematic: args.schematic ?? record.schematic,
          })
        } catch (error) {
          throw describe(error)
        }
        if (!dryRun) {
          store.modules = (store.modules ?? []).filter((m) => String(m.name) !== String(record.name))
          await writeModuleStore(storeFile, store)
        }
        return {
          ...value,
          name: record.name,
          wires: wires,
          deleteComponents: deleteComponents,
          moduleCount: dryRun ? (store.modules ?? []).length : (store.modules ?? []).length,
          ...storeInfo,
        }
      }

      throw new Error(`Unknown action: ${action}. Use create, list, locate, or delete.`)
    },
  })

  ctx.tools.register({
    name: 'eda_pcb',
    description:
      'Summarize the PCB: footprint placement with layer, rotation and coordinates, net, track and via counts, board outline segments, '
      + 'the coordinate extent of the placement, and which schematic parts are not placed yet. Set drc to run a design rule check '
      + 'and return its violations.',
    parameters: schema({
      drc: { type: 'boolean', description: 'Run a design rule check and include the violations. Slower on a dense board.' },
      pcbIndex: { type: 'integer', description: 'Which PCB of the project to read, in eda list order. Default 0.' },
      limit: { type: 'integer', description: 'Footprints and violations listed. Default 80 and 20.' },
      session: SESSION,
    }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      return run(scope, args, PCB, {
        drc: args.drc === true,
        pcbIndex: args.pcbIndex,
        limit: args.limit,
        readyTimeoutMs: 30000,
      }, 180000)
    },
  })

  ctx.tools.register({
    name: 'eda_pcb_draw',
    description:
      'Draw on the PCB: copper lines and polylines on a layer, vias, and the board outline. All operations of one call form a single '
      + 'undoable group, and the group is rolled back when any operation fails unless rollbackOnError is false. Coordinates are the PCB '
      + 'data coordinate system in mil. Set importChanges to first pull the schematic into the PCB, and dryRun to validate the batch '
      + 'without drawing.',
    parameters: schema({
      ops: {
        type: 'array',
        description: 'Operations applied in order. A line, polyline or outline needs points; a via needs x and y.',
        items: schema({
          kind: { type: 'string', enum: ['line', 'polyline', 'via', 'outline'], description: 'Operation kind. outline draws the board outline on layer 11.' },
          net: { type: 'string', description: 'Net name the copper belongs to. Empty for unconnected copper.' },
          layer: { type: 'integer', description: 'Copper layer: 1 top, 2 bottom, 15+ inner layers. Defaults to the layer argument.' },
          points: {
            type: 'array',
            description: 'Polyline vertices as [x, y] pairs in mil, at least two for a line.',
            items: { type: 'array', items: { type: 'number' } },
          },
          x: { type: 'number', description: 'Via center X in mil.' },
          y: { type: 'number', description: 'Via center Y in mil.' },
          width: { type: 'number', description: 'Trace width in mil. Defaults to the width argument.' },
          hole: { type: 'number', description: 'Via drill diameter in mil. Default 20.' },
          diameter: { type: 'number', description: 'Via outer diameter in mil. Default 40.' },
        }, ['kind']),
      },
      layer: { type: 'integer', description: 'Layer applied to operations that omit one. Default 1 (top).' },
      width: { type: 'number', description: 'Trace width in mil for operations that omit one. Default 10.' },
      importChanges: { type: 'boolean', description: 'Import schematic changes into the PCB before drawing.' },
      dryRun: { type: 'boolean', description: 'Report the planned operations without changing the PCB.' },
      rollbackOnError: { type: 'boolean', description: 'Discard the whole group when one operation fails. Default true.' },
      groupName: { type: 'string', description: 'Undo step label for the whole batch.' },
      pcbIndex: { type: 'integer', description: 'Which PCB of the project to draw on. Default 0.' },
      session: SESSION,
    }, ['ops']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      return run(scope, args, DRAW, {
        ops: args.ops,
        layer: args.layer,
        width: args.width,
        importChanges: args.importChanges === true,
        dryRun: args.dryRun === true,
        rollbackOnError: args.rollbackOnError !== false,
        groupName: args.groupName,
        pcbIndex: args.pcbIndex,
        limit: 40,
        readyTimeoutMs: 30000,
      }, 180000)
    },
  })

  ctx.tools.register({
    name: 'eda_pcb_layout',
    description:
      'Place or move PCB footprints, and run the client auto-placer and auto-router as background jobs. '
      + 'place moves existing footprints that are already on the board, so run it with importChanges after the schematic changes. '
      + 'auto_layout and auto_route start a job, wait up to waitMs, and return the job status plus the resulting footprint, track and '
      + 'via counts; when the job is still running, poll it with action job_status and its jobId.',
    parameters: schema({
      action: { type: 'string', enum: ['place', 'auto_layout', 'auto_route', 'job_status'], description: 'Operation to run.' },
      moves: {
        type: 'array',
        description: 'Footprint moves for action place, in PCB data coordinates (mil).',
        items: schema({
          designator: { type: 'string', description: 'Existing PCB footprint designator, for example U1.' },
          x: { type: 'number', description: 'New center X in mil.' },
          y: { type: 'number', description: 'New center Y in mil.' },
          rotation: { type: 'number', description: 'New rotation in degrees.' },
          layer: { type: 'integer', description: 'New component layer: 1 top, 2 bottom.' },
        }, ['designator']),
      },
      importChanges: { type: 'boolean', description: 'Import schematic changes into the PCB before acting. Use it before place on a fresh board.' },
      nets: { type: 'array', items: { type: 'string' }, description: 'Nets to route. Default all unrouted nets.' },
      ignoreNets: { type: 'array', items: { type: 'string' }, description: 'Nets to leave unrouted.' },
      layers: { type: 'array', items: { type: 'integer' }, description: 'Copper layers the router may use: 1 top, 2 bottom, 15+ inner.' },
      jobId: { type: 'string', description: 'Job to inspect, for action job_status.' },
      waitMs: { type: 'integer', description: 'How long to wait for the job inside this call. Default 120000.' },
      pcbIndex: { type: 'integer', description: 'Which PCB of the project to work on. Default 0.' },
      session: SESSION,
    }, ['action']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const waitMs = Number.isFinite(args.waitMs) && args.waitMs > 0 ? Math.min(args.waitMs, 900000) : 120000
      return run(scope, args, LAYOUT, {
        action: args.action,
        moves: args.moves,
        importChanges: args.importChanges === true,
        nets: args.nets,
        ignoreNets: args.ignoreNets,
        layers: args.layers,
        jobId: args.jobId,
        waitMs,
        pcbIndex: args.pcbIndex,
        readyTimeoutMs: 30000,
      }, waitMs + 120000)
    },
  })

  ctx.tools.register({
    name: 'eda_export',
    description:
      'Export a manufacturing or documentation file to a directory on this machine and verify each file landed on disk. '
      + 'BOM and netlist are exported from the schematic; gerber, pick-and-place and pdf from the PCB.',
    parameters: schema({
      kind: { type: 'string', enum: ['bom', 'gerber', 'pickplace', 'netlist', 'pdf'], description: 'Artifact to export.' },
      dir: { type: 'string', description: 'Absolute target directory. Created when missing.' },
      baseName: { type: 'string', description: 'File name without extension. Default export.' },
      format: { type: 'string', description: 'bom and pickplace file type: xlsx or csv. Default xlsx.' },
      netlistType: { type: 'string', description: 'Netlist flavour, for example JLCEDA, PADS, PROTEL2, ALLEGRO.' },
      session: SESSION,
    }, ['kind', 'dir']),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      if (!isAbsolute(args.dir)) throw new Error('dir must be an absolute path.')
      await mkdir(args.dir, { recursive: true })
      const result = await run(scope, args, EXPORT, {
        kind: args.kind,
        dir: args.dir.replaceAll('\\', '/'),
        baseName: args.baseName ?? 'export',
        format: args.format,
        netlistType: args.netlistType,
      }, 180000)
      for (const file of result.files ?? []) {
        const absolute = file.path ?? joinPath(args.dir, file.name)
        file.onDisk = existsSync(absolute)
        if (file.onDisk) {
          file.bytes = statSync(absolute).size
          if (file.bytes <= 8) file.warning = 'the exported file is empty or a placeholder'
        }
      }
      return result
    },
  })

  ctx.tools.register({
    name: 'eda_run',
    description:
      'Run JavaScript inside the editor session against the extension API (eda.*) and return its value. '
      + 'Use it for anything the purpose-built tools do not cover; read the exact class and signature with eda_reference first. '
      + 'The script is an async function body: read args via __CLI__.args and return a JSON value. '
      + 'Requires a session, and runs with system extension permission by default.',
    parameters: schema({
      code: { type: 'string', description: 'Async function body. Mutually exclusive with codeFile.' },
      codeFile: { type: 'string', description: 'Absolute path of a file holding the body. Use for long generated scripts.' },
      args: { type: 'object', description: 'Object exposed to the script as __CLI__.args.' },
      elevated: { type: 'boolean', description: 'Run with system extension permission. Default true; false uses independent script permission.' },
      timeoutMs: { type: 'integer', description: 'Invocation budget in ms. Default 60000.' },
      session: SESSION,
    }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      let code = args.code
      if (typeof args.codeFile === 'string' && args.codeFile !== '') {
        const { readFile } = await import('node:fs/promises')
        code = await readFile(args.codeFile, 'utf8')
      }
      if (typeof code !== 'string' || code.trim() === '') throw new Error('Pass code or codeFile.')
      const timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : 60000
      try {
        const session = await resolveSession(cli, args.session, config)
        const value = await cli.invoke({
          sessionId: session.sessionId,
          code,
          args: args.args,
          elevated: args.elevated !== false,
          timeoutMs,
        })
        const project = session.path ?? (await resolveProjectFile(cli, session.sessionId, null)) ?? undefined
        return { session: { id: session.sessionId, project }, value }
      } catch (error) {
        throw describe(error)
      }
    },
  })

  ctx.tools.register({
    name: 'eda_reference',
    description:
      'Read the editor API reference shipped with the installed client, so signatures are not guessed: list the API surface, list the '
      + 'methods of one class, show one method, or read a design-format type definition.',
    parameters: schema({
      kind: { type: 'string', enum: ['api', 'format'], description: 'Namespace to query: api (eda.*) or format (design file fields). Default api.' },
      className: { type: 'string', description: 'Class, interface, enum or format type name, for example SCH_SourceDocument.' },
      methodName: { type: 'string', description: 'Method of that class, for example get. Requires className and kind api.' },
    }),
    output: { schema: {}, render: (_args, value) => text(value) },
    async execute(args) {
      const kind = args.kind === 'format' ? 'format' : 'api'
      const cliArgs = [kind]
      if (typeof args.className === 'string' && args.className !== '') cliArgs.push('--class-name', args.className)
      if (kind === 'api' && typeof args.methodName === 'string' && args.methodName !== '') cliArgs.push('--method-name', args.methodName)
      let value
      try {
        value = await cli.documentation(cliArgs)
      } catch (error) {
        throw describe(error)
      }
      if (typeof args.methodName === 'string' && args.methodName !== '') return value
      if (typeof args.className === 'string' && args.className !== '') {
        const methods = Array.isArray(value?.methods) ? value.methods : []
        const fields = Array.isArray(value?.fields) ? value.fields : []
        const values = Array.isArray(value?.values) ? value.values : []
        if (methods.length > 0) {
          return {
            className: args.className,
            description: value.comment ?? value.title,
            methods: methods.slice(0, 200).map((m) => ({ name: m.name, comment: m.comment })),
            methodCount: methods.length,
          }
        }
        return value
      }
      const types = Array.isArray(value?.types) ? value.types : []
      return {
        kind,
        description: value?.description,
        typeCount: types.length,
        types: types.slice(0, 400).map((t) => ({ name: t.name, comment: t.comment })),
      }
    },
  })
}
