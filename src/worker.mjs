import { cli, stopAll } from './orca.mjs'
import { tg, chunks, accept } from './telegram.mjs'
import { chatSend, chatSettle } from './chat.mjs'

const TURN_MS = 2 * 60 * 60 * 1000
const AGENTS = ['claude', 'codex']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const loops = new Map() // unit id → AbortController of its Telegram poll

export function deactivate() {
  for (const loop of loops.values()) loop.abort()
  stopAll()
}

export default async function activate(orca) {
  const units = await orca.storage.get('units') || {}
  const errors = {} // unit id → problem shown in the panel
  const save = () => orca.storage.set('units', units)

  function changed(id, error) {
    if (id) errors[id] = error
    const text = `Telegram: ${loops.size}/${Object.keys(units).length}`
    void orca.host.call('statusBar.update', { id: 'units', text }).catch(() => {})
    orca.panels.post('changed', {})
  }

  // A unit is an Orca chat: the role is its first message, and Orca keeps the conversation.
  async function launch(unit) {
    const intro = `You are unit "${unit.name}". People write to you from Telegram and see only the text of your replies once the turn ends. Do not ask questions through tools: decide yourself or ask in plain text. Reply in the language you are written to in.`
    const prompt = [intro, unit.role].filter(Boolean).join('\n\n')
    const model = unit.model ? ['--model', unit.model] : []
    const args = ['agent', 'launch', '--agent', unit.agent, '--worktree', 'path:' + unit.dir, '--surface', 'chat', ...model, '--prompt', prompt]
    const result = await cli(args)
    if (result.outcome?.kind !== 'structured') throw new Error('Orca opened a terminal instead of a chat: ' + (result.receipt?.detail || 'no reason given'))
    unit.sessionId = result.outcome.sessionId
  }

  // Quiet mode: the whole turn's text arrives as one reply when the agent finishes.
  // `resumed` is a turn a previous run of the plugin already sent: only its reply is still owed.
  async function turn(id, token, message, resumed = false) {
    const { chat, thread, text, id: replyTo } = message
    // Answer where the person wrote: the same forum topic, as a reply to their message.
    const place = { chat_id: chat, message_thread_id: thread }
    const reply = { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
    const say = async message => { for (const part of chunks(message)) await tg(token, 'sendMessage', { ...place, ...reply, text: part }) }
    const typing = () => tg(token, 'sendChatAction', { ...place, action: 'typing' }).catch(() => {})
    void typing()
    const timer = setInterval(typing, 5000)
    // Seen: the turn can take minutes, and the reply only comes at its end.
    void tg(token, 'setMessageReaction', { chat_id: chat, message_id: replyTo, reaction: [{ type: 'emoji', emoji: '👀' }] }).catch(() => {})
    let base = resumed ? message.base : undefined
    try {
      const unit = units[id]
      base ??= await chatSend(unit.sessionId, text)
      // Remember the sent turn, so a plugin restart still delivers its reply and never sends it twice.
      await orca.storage.set('turn:' + id, { ...message, base })
      const held = () => say('The agent chat is on hold (usage limit, pause or an open question in Orca). Your message is queued; the reply will come when the chat resumes.')
      const result = await chatSettle(unit.sessionId, text, base, TURN_MS, held)
      const entries = result.entries
      const spoken = entries.filter(e => e.kind === 'error' || e.role === 'assistant').map(e => e.text)
      const waiting = entries.filter(e => e.pending).map(e => e.text)
      const notes = [
        result.truncated && '(The start of the reply did not fit; the full text is in the Orca chat.)',
        result.settled === 'blocked' && 'The agent is waiting for your answer in Orca:\n' + waiting.join('\n'),
        result.settled === 'timeout' && 'The agent is still working; see the result in the Orca chat.'
      ]
      await say([...spoken, ...notes].filter(Boolean).join('\n\n') || 'The turn ended without text.')
    } catch (error) {
      // Once sent, the agent has the message: say so, or the owner would send it twice.
      const lost = base === undefined ? 'Not delivered: ' : 'Delivered, but the reply was lost (see the Orca chat): '
      await say(lost + error.message).catch(e => changed(id, e.message))
    } finally {
      clearInterval(timer)
      await orca.storage.delete('turn:' + id)
    }
  }

  // One message at a time: Telegram keeps the rest of the queue, so no message waits in this process's memory.
  // `resume` finishes a turn the previous run of the plugin sent: only its reply is still owed.
  async function poll(id, signal, resume) {
    const token = await orca.secrets.get('token:' + id)
    let offset = await orca.storage.get('offset:' + id) || 0
    let delay = 1000
    let bot
    while (!signal.aborted) {
      try {
        const left = resume && await orca.storage.get('turn:' + id)
        resume = false
        if (left) await turn(id, token, left, true)
        bot ||= await tg(token, 'getMe', {}, signal)
        const [update] = await tg(token, 'getUpdates', { offset, limit: 1, timeout: 30, allowed_updates: ['message'] }, signal)
        delay = 1000
        if (errors[id]) changed(id, null)
        if (!update) continue
        // At most once: confirm the message before acting, so a crash can never make a full-permission agent repeat it.
        offset = update.update_id + 1
        await orca.storage.set('offset:' + id, offset)
        const message = accept(update, bot)
        if (message) await turn(id, token, message)
      } catch (error) {
        if (signal.aborted) return
        if (error.code === 409 || error.code === 401) {
          // Another program polls this token, or the token is wrong: retrying would only fight it.
          loops.delete(id)
          return changed(id, error.message)
        }
        changed(id, error.message)
        await sleep(delay)
        delay = Math.min(delay * 2, 30000)
      }
    }
  }

  function start(id, resume = false) {
    if (loops.has(id)) return
    const loop = new AbortController()
    loops.set(id, loop)
    poll(id, loop.signal, resume).catch(error => { loops.delete(id); changed(id, error.message) })
  }
  function stop(id) {
    loops.get(id)?.abort()
    loops.delete(id)
  }
  function unitOf(id) {
    if (!Object.hasOwn(units, id)) throw new Error('Unit not found')
    return units[id]
  }

  async function state() {
    const list = Object.entries(units).map(([id, unit]) => ({ id, ...unit, connected: loops.has(id), error: errors[id] || null }))
    return { units: list }
  }

  orca.panels.handle('state', state)
  orca.panels.handle('projects', async () => {
    const { repos } = await cli(['repo', 'list'])
    return repos.map(r => ({ value: r.path, label: `${r.displayName} · ${r.path}` }))
  })

  orca.panels.handle('unit.save', async input => {
    const name = String(input.name || '').trim()
    const role = String(input.role || '').trim()
    const token = String(input.token || '').trim()
    if (!name) throw new Error('Enter a name')
    if (!input.id && !token) throw new Error('Enter the bot token')
    if (input.id) unitOf(input.id)
    // Telegram is the judge of a token: getMe fails on a wrong one and names the bot of a right one.
    const bot = token && 'bot-' + (await tg(token, 'getMe')).id
    if (input.id && bot && bot !== input.id) throw new Error('This token belongs to another bot: add it as a new unit')
    if (!input.id && Object.hasOwn(units, bot)) throw new Error('This bot is already added')
    const id = input.id || bot
    if (token) await orca.secrets.set('token:' + id, token)
    units[id] = { ...units[id], name, role }
    await save()
    changed()
    return state()
  })

  orca.panels.handle('unit.connect', async ({ id, dir, agent, model, fresh }) => {
    const old = unitOf(id)
    const next = { dir: String(dir || ''), agent, model: String(model || '').trim() }
    if (!next.dir || !AGENTS.includes(agent)) throw new Error('Choose a project and a provider')
    const unit = { ...old, ...next, enabled: true }
    // The chat keeps its context for as long as the unit stays in the same place; moving it starts a new one.
    if (['dir', 'agent', 'model'].some(key => old[key] !== next[key])) delete unit.sessionId
    if (fresh || !unit.sessionId) await launch(unit)
    units[id] = unit
    await save()
    start(id)
    changed(id, null)
    return state()
  })

  orca.panels.handle('unit.disconnect', async ({ id }) => {
    unitOf(id).enabled = false
    stop(id)
    await save()
    changed(id, null)
    return state()
  })

  orca.panels.handle('unit.remove', async ({ id }) => {
    unitOf(id)
    stop(id)
    delete units[id]
    await orca.secrets.delete('token:' + id)
    await orca.storage.delete('offset:' + id)
    await orca.storage.delete('turn:' + id)
    await save()
    changed(id, null)
    return state()
  })

  for (const [id, unit] of Object.entries(units)) if (unit.enabled && unit.sessionId) start(id, true)
  changed()
}
