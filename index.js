/**
 * SDD Compass — Host half.
 *
 * Computes the spec-driven state of the session's project (OpenSpec or the
 * `.scratch` flow), exposes it as a system-prompt section, one session-start
 * briefing, the `sdd_status` / `sdd_check` tools, the `/sdd` command and a
 * same-origin route for the Web Client.
 *
 * Read-only over project sources; the only write is `/sdd init`, which creates
 * `.sdd/config.json` and never overwrites it.
 */

import { SddService } from './src/service.js'
import { checkTool, projectsTool, statusTool } from './src/tools.js'

export const name = 'sdd-compass'
export const inject = ['tools', 'commands', 'systemPrompt']

export function apply(ctx) {
  const service = new SddService(ctx)
  ctx.effect(
    () => () => {
      service.dispose()
    },
    'sdd-compass: state',
  )

  // Short, byte-stable state line in the system prompt.
  ctx.systemPrompt.section({
    name: 'sdd:compass',
    order: 900,
    text: (context) => service.promptText(context),
  })

  // Session bookkeeping: remember which directory each session works in, so
  // the dock can query the right project before the first prompt is assembled.
  ctx.on('session/created', (session) => {
    const cwd = session?.header?.cwd
    if (session?.id && cwd) service.rememberSession(session.id, cwd)
  })
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    const cwd = agent?.session?.header?.cwd
    if (agent?.id && cwd) service.rememberSession(agent.id, cwd)
  })
  ctx.on('agent/session-start', (payload) => {
    if (payload?.agent) void service.seed(payload.agent)
  })

  // Model surfaces.
  ctx.tools.register(statusTool(service))
  ctx.tools.register(checkTool(service))
  ctx.tools.register(projectsTool(service))

  // Opt-in hard gate: refuse code writes while the change is still in
  // proposal/spec/design and `strictness` is `gate`.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (decision?.kind !== 'allow') return decision
    try {
      const reason = await service.gateReason(exec)
      return reason ? { kind: 'deny', reason } : decision
    } catch {
      return decision
    }
  })

  // Post-write nudge: attach one model-facing warning after a code write in a
  // pre-implementation phase (`strictness` warn or gate).
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision?.kind !== 'accept') return decision
    try {
      const warning = await service.writeWarning(exec)
      if (!warning) return decision
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), warning] }
    } catch {
      return decision
    }
  })

  // Human surface: /sdd without sending a model message.
  ctx.commands.register({
    name: 'sdd',
    description: 'Состояние SDD проекта: фаза, следующий шаг, замечания, документы, статистика',
    input: { hint: 'status | next | check | docs | stats | init | refresh' },
    handler: (invocation) => service.command(invocation),
  })

  // Web surface: same-origin JSON for the composer dock and the panel.
  // Headless shells have no webServer; the plugin then keeps the other surfaces.
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: '/api/sdd',
          handler: (req, res) => service.handleHttp(req, res),
        }),
      'sdd-compass: route',
    )
  })
}
