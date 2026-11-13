import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const children = new Set()
export function stopAll() { for (const child of children) child.kill() }

// Orca starts plugin workers without the per-user folders its CLI needs on Windows.
function hostEnv() {
  const env = { ...process.env }
  if (process.platform === 'win32') {
    env.APPDATA ||= join(homedir(), 'AppData', 'Roaming')
    env.LOCALAPPDATA ||= join(homedir(), 'AppData', 'Local')
    env.USERPROFILE ||= homedir()
  }
  return env
}

function command() {
  const name = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const bundled = join(dirname(process.execPath), 'resources', 'bin', name)
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND
  if (existsSync(bundled)) return bundled
  return process.platform === 'linux' ? 'orca-ide' : name
}

// Runs `orca <args> --json` on this machine's Orca without a shell and resolves with its `result`.
export function cli(args) {
  const argv = [...args, '--environment', 'local', '--json']
  const options = { env: hostEnv(), windowsHide: true, timeout: 90000, maxBuffer: 16 * 1024 * 1024 }
  return new Promise((resolve, reject) => {
    const child = execFile(command(), argv, options, (error, stdout) => {
      children.delete(child)
      let response
      try { response = JSON.parse(stdout) } catch { return reject(new Error(`Orca CLI gave no answer (${error?.code ?? 'empty output'})`)) }
      // A wait that times out exits 1 but still prints its result, so trust the JSON, not the exit code.
      if (response.ok) return resolve(response.result)
      reject(Object.assign(new Error(response.error?.message || 'Orca refused the operation'), { code: response.error?.code }))
    })
    children.add(child)
    child.stdin.end()
  })
}
