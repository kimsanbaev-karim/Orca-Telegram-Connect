// ponytail: Orca's plugin API cannot message an agent chat, and `orca chat send/wait` was reverted before release
// (https://github.com/stablyai/orca/pull/41241), so we make the same two runtime calls over Orca's local socket.
// These calls are Orca internals and may change with any release. If `orca chat send` ships
// (https://github.com/stablyai/orca/pull/41850), replace chatSend with cli(['chat', 'send', ...]).
import { createConnection } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function userData() {
  if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'orca')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'orca')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca')
}

// One JSON line out, JSON lines back; the frame carrying our id is the answer.
async function rpc(method, params) {
  const meta = JSON.parse(await readFile(join(userData(), 'orca-runtime.json'), 'utf8'))
  const endpoint = meta.transports.find(t => t.kind === 'named-pipe' || t.kind === 'unix')?.endpoint
  if (!endpoint) throw new Error('Orca is not running')
  const id = randomUUID()
  const frame = await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.setTimeout(30000, () => socket.destroy(new Error('Orca did not answer')))
    socket.once('error', () => reject(new Error('No connection to Orca')))
    socket.once('close', () => reject(new Error('Orca closed the connection')))
    socket.once('connect', () => socket.write(JSON.stringify({ id, authToken: meta.authToken, method, params }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      const answer = lines.filter(Boolean).map(line => JSON.parse(line)).find(f => f.id === id)
      if (!answer) return
      resolve(answer)
      socket.end()
    })
  })
  if (!frame.ok) throw new Error(frame.error?.message || 'Orca refused the operation')
  return frame.result
}

// Orca rejects a send whose fingerprint does not match its payload; this is its canonical JSON.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

// What a reader follows: the agent's messages and errors, and prompts still waiting for an answer.
function entry(item, actionable) {
  const body = item.body
  if (item.agentId) return null // a subagent's row
  if (body.kind === 'message' && body.role !== 'reasoning') {
    const text = body.blocks.map(b => (b.type === 'text' ? b.text : b.type === 'image-ref' ? '[image]' : '')).filter(Boolean).join('\n').trim()
    return text ? { kind: 'message', role: body.role, text } : null
  }
  if (body.kind === 'status' && body.tone === 'error') return { kind: 'error', text: String(body.text) }
  if (body.kind !== 'question' && body.kind !== 'approval') return null
  const text = body.kind === 'approval' ? body.title : (body.questions || [body]).map(q => q.question).join('\n')
  return { kind: body.kind, text, pending: body.resolution?.state === 'pending' && actionable.includes(item.itemId) }
}

const page = async (sessionId, limit) => (await rpc('agentSession.history', { sessionId, direction: 'tail', limit })).page

// Sends `text` as the user's message; resolves with the history position it was sent after.
export async function chatSend(sessionId, text) {
  const { fence, window } = await page(sessionId, 1)
  if (fence === undefined) throw new Error('The chat is not running: open it in Orca, or connect the unit again with "Start a new chat" checked.')
  const fields = { body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: text.trimEnd() }] }, delivery: 'queue-if-active' }
  const payloadFingerprint = createHash('sha256').update(canonical({ method: 'agentSession.send', sessionId, fields })).digest('hex')
  const clientOperationId = `${Date.now()}-${randomUUID().replaceAll('-', '')}`
  const sent = await rpc('agentSession.send', { envelope: { sessionId, clientOperationId, expectedRuntimeFence: fence, payloadFingerprint }, ...fields })
  if (!sent.ok) throw new Error(sent.refusal?.message || 'Orca did not accept the message')
  return window?.newest?.sequence ?? 0
}

const isUser = e => e.kind === 'message' && e.role === 'user'

// The agent's answer to `text`: what follows that user message, up to the next one.
// null while the message has not reached the chat (still queued), so an older reply is never mistaken for it.
export function answerTo(rows, text, scrolledOut = false) {
  const mine = rows.findIndex(e => isUser(e) && e.text === text.trim())
  if (mine === -1 && !scrolledOut) return null
  const after = rows.slice(mine + 1)
  const next = after.findIndex(isUser)
  return next === -1 ? after : after.slice(0, next)
}

// Waits until the chat has taken `text` (sent after history position `base`) and gone quiet; resolves with the answer.
// `onHeld` is called once if the chat stands still with the message unread: a usage limit, a pause, an open prompt.
// ponytail: with other messages queued behind ours the chat never goes quiet between turns, so the answer
// arrives only after them; watch for the next user message instead if that starts to matter.
export async function chatSettle(sessionId, text, base, timeoutMs, onHeld) {
  const deadline = Date.now() + timeoutMs
  let warned = false
  while (Date.now() < deadline) {
    await sleep(1000)
    const now = await page(sessionId, 1)
    const blocked = now.actionablePromptIds?.length > 0
    if (!blocked && (now.working || now.nextQueuedMessageId != null)) continue
    const last = await page(sessionId, 200)
    const rows = last.items.filter(item => item.sequence > base).map(item => entry(item, last.actionablePromptIds || [])).filter(Boolean)
    const scrolledOut = last.window?.oldest?.sequence > base + 1
    const entries = answerTo(rows, text, scrolledOut)
    if (entries) return { settled: blocked ? 'blocked' : 'done', entries, truncated: scrolledOut }
    if (warned || !(blocked || now.queuedMessages?.length)) continue
    warned = true
    await onHeld()
  }
  return { settled: 'timeout', entries: [], truncated: false }
}
