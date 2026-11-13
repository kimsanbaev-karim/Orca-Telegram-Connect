import { atom, read, set, plugin, Stack, Row, Text, Heading, Button, Input, Textarea, Select, Checkbox, Card, Callout, EmptyState } from 'orca'
import type { PanelContext } from 'orca'
import type { Launch, Option, State, Unit } from './contracts'

const AGENTS: Option[] = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }]

const state = atom<State>({ units: [] })
const busy = atom(false)
const error = atom('')
const edit = atom<{ id?: string; name: string; token: string; role: string } | null>(null)
const launch = atom<(Launch & { name: string; hasChat: boolean }) | null>(null)
const projects = atom<Option[]>([])

// Every button goes through here: one request at a time, and its failure is shown, not thrown.
async function act(action: () => Promise<State | void>) {
  if (read(busy)) return
  set(busy, true); set(error, '')
  try { const next = await action(); if (next) set(state, next) }
  catch (e) { set(error, e instanceof Error ? e.message : String(e)) }
  finally { set(busy, false) }
}

export function setup(ctx: PanelContext) {
  const refresh = () => plugin.request('state', {}, { signal: ctx.signal }).then(next => set(state, next), () => {})
  void refresh()
  ctx.subscriptions.push(plugin.on('changed', refresh))
}

function connect(unit: Unit) {
  return act(async () => {
    set(projects, await plugin.request('projects', {}))
    set(launch, { id: unit.id, name: unit.name, dir: unit.dir || '', agent: unit.agent || 'claude',
      model: unit.model || '', fresh: false, hasChat: Boolean(unit.sessionId) })
  })
}

function Connect() {
  const value = read(launch)!
  const change = (patch: Partial<Launch>) => set(launch, { ...value, ...patch })
  return <Card title={`Connect: ${value.name}`}><Stack gap="md">
    <Select label="Orca project" value={value.dir} placeholder="Choose a project" options={read(projects)} disabled={read(busy)}
      onChange={dir => change({ dir })} />
    {!read(projects).length && <Text muted size="sm">Orca has no projects. Add one in Orca and press Connect again.</Text>}
    <Select label="Provider" value={value.agent} options={AGENTS} disabled={read(busy)} onChange={agent => change({ agent, model: '' })} />
    <Input label="Model" value={value.model} placeholder="Orca default" maxLength={160} disabled={read(busy)} onChange={model => change({ model })} />
    {value.hasChat && <Checkbox label="Start a new chat" description="Unchecked, the unit continues its conversation if the project, provider and model are the same."
      checked={value.fresh} disabled={read(busy)} onChange={fresh => change({ fresh })} />}
    <Text muted size="sm">The account is the one selected in Orca for this provider; all units share it.</Text>
    <Row wrap gap="sm">
      <Button disabled={read(busy) || !value.dir} onPress={() => act(async () => {
        const { name, hasChat, ...input } = value
        const next = await plugin.request('unit.connect', input, { timeoutMs: 120000 })
        set(launch, null)
        return next
      })}>Connect</Button>
      <Button variant="ghost" disabled={read(busy)} onPress={() => set(launch, null)}>Cancel</Button>
    </Row>
  </Stack></Card>
}

function Settings() {
  const value = read(edit)!
  return <Card title={value.id ? 'Unit settings' : 'Add a unit'}><Stack gap="sm">
    <Input label="Name" value={value.name} maxLength={120} disabled={read(busy)} onChange={name => set(edit, { ...value, name })} />
    <Input label="Bot token" type="password" value={value.token} placeholder={value.id ? 'Leave empty to keep the current one' : 'Token from BotFather'}
      disabled={read(busy)} onChange={token => set(edit, { ...value, token })} />
    <Textarea label="Role" value={value.role} rows={8} maxLength={4000} placeholder="Who this unit is and what it does. Sent to the agent as the first message of a new chat."
      disabled={read(busy)} onChange={role => set(edit, { ...value, role })} />
    <Row wrap gap="sm">
      <Button disabled={read(busy) || !value.name.trim() || (!value.id && !value.token.trim())} onPress={() => act(async () => {
        const next = await plugin.request('unit.save', value)
        set(edit, null)
        return next
      })}>Save</Button>
      <Button variant="ghost" disabled={read(busy)} onPress={() => set(edit, null)}>Cancel</Button>
    </Row>
  </Stack></Card>
}

function UnitCard({ unit }: { unit: Unit }) {
  const model = unit.agent && (unit.model || 'Orca default model')
  const where = [AGENTS.find(a => a.value === unit.agent)?.label, model, unit.dir].filter(Boolean).join(' · ')
  return <Card><Stack gap="sm">
    <Row wrap gap="sm">
      <Text tone={unit.connected ? 'success' : 'danger'}>●</Text>
      <Text weight="semibold">{unit.name}</Text>
      {where && <Text muted size="sm">{where}</Text>}
    </Row>
    {unit.error && <Text tone="danger" size="sm">{unit.error}</Text>}
    <Row wrap gap="sm">
      <Button disabled={read(busy)} onPress={() => unit.connected ? act(() => plugin.request('unit.disconnect', { id: unit.id })) : connect(unit)}>
        {unit.connected ? 'Disconnect' : 'Connect'}</Button>
      <Button variant="outline" disabled={read(busy)} onPress={() => set(edit, { id: unit.id, name: unit.name, token: '', role: unit.role })}>Settings</Button>
      <Button variant="ghost" tone="danger" disabled={read(busy) || unit.connected} onPress={() => act(() => plugin.request('unit.remove', { id: unit.id }))}>Remove</Button>
    </Row>
  </Stack></Card>
}

export default function Panel() {
  const { units } = read(state)
  return <Stack gap="md">
    <Heading>Telegram Connect</Heading>
    {read(error) && <Callout tone="danger">{read(error)}</Callout>}
    {read(launch) ? <Connect /> : read(edit) ? <Settings /> : <Stack gap="md">
      {!units.length && <EmptyState title="No units yet" description="Add a name, a Telegram bot token and a role." />}
      {units.map(unit => <UnitCard key={unit.id} unit={unit} />)}
      <Button icon="add" variant="outline" disabled={read(busy)} onPress={() => set(edit, { name: '', token: '', role: '' })}>Add a unit</Button>
    </Stack>}
  </Stack>
}
