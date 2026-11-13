export type Unit = { id: string; name: string; role: string; dir?: string; agent?: string; model?: string;
  sessionId?: string; enabled?: boolean; connected: boolean; error: string | null }
export type State = { units: Unit[] }
export type Option = { value: string; label: string }
export type Launch = { id: string; dir: string; agent: string; model: string; fresh: boolean }

declare module 'orca' {
  interface PluginRequests {
    'state': { input: {}; output: State }
    'projects': { input: {}; output: Option[] }
    'unit.save': { input: { id?: string; name: string; token: string; role: string }; output: State }
    'unit.connect': { input: Launch; output: State }
    'unit.disconnect': { input: { id: string }; output: State }
    'unit.remove': { input: { id: string }; output: State }
  }
  interface PluginPanelEvents { 'changed': {} }
}
