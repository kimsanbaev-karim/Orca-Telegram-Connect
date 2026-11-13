import assert from 'node:assert/strict'
import test from 'node:test'
import { chunks, accept } from '../src/telegram.mjs'
import { answerTo } from '../src/chat.mjs'

test('long replies split on boundaries, lose nothing and fit Telegram', () => {
  const text = Array.from({ length: 400 }, (_, i) => `Абзац ${i}: ` + 'слово '.repeat(8).trim()).join('\n\n')
  const parts = chunks(text)
  assert.ok(parts.length > 1 && parts.every(part => part.length <= 4096))
  assert.equal(parts.join('\n\n'), text)
  assert.deepEqual(chunks('x'.repeat(5000)).map(part => part.length), [4096, 904])
  assert.deepEqual(chunks(''), [])
})

test('a unit hears a group member who addresses it, and nobody in private', () => {
  const bot = { id: 99, username: 'unit_bot' }
  const update = (patch = {}) => ({ message: { message_id: 3, chat: { type: 'supergroup', id: -1 }, from: { id: 8, first_name: 'Юра' }, text: '@Unit_Bot привет', ...patch } })
  assert.deepEqual(accept(update(), bot), { chat: -1, id: 3, text: 'Юра: привет' })
  assert.equal(accept(update({ is_topic_message: true, message_thread_id: 11 }), bot).thread, 11)
  assert.equal(accept(update({ text: 'привет', reply_to_message: { from: { id: 99 } } }), bot).text, 'Юра: привет', 'a reply to the bot')
  assert.equal(accept(update({ text: 'привет' }), bot), null, 'group talk not addressed to the bot')
  assert.equal(accept(update({ text: '@other_bot привет' }), bot), null, 'another bot is addressed')
  assert.equal(accept(update({ text: '@unit_bot2 привет' }), bot), null, 'a bot whose name only starts like ours')
  assert.equal(accept(update({ chat: { type: 'private', id: 8 } }), bot), null, 'private chats are closed')
  assert.equal(accept(update({ text: undefined }), bot), null, 'a photo or voice')
  assert.equal(accept({ edited_message: {} }, bot), null)
})

test('the answer is what follows our message, never an older reply', () => {
  const user = text => ({ kind: 'message', role: 'user', text })
  const bot = text => ({ kind: 'message', role: 'assistant', text })
  assert.equal(answerTo([bot('старый отчёт')], 'Юра: привет'), null) // still queued behind a usage limit
  assert.deepEqual(answerTo([bot('старый'), user('Юра: привет'), bot('ответ'), user('дальше'), bot('другое')], 'Юра: привет \n'), [bot('ответ')])
  assert.deepEqual(answerTo([bot('хвост')], 'Юра: привет', true), [bot('хвост')]) // our message scrolled out of the page
})
