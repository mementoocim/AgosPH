import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
if (!existsSync(python)) {
  console.error('Python environment is missing. Run scripts/setup.ps1 first.');
  process.exit(1);
}
const backend = spawn(
  python,
  [
    '-m',
    'uvicorn',
    'backend.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    '8000',
  ],
  { cwd: root, stdio: 'inherit' },
);
const frontend = spawn(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['run', 'dev', '--workspace', 'frontend'],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' },
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [backend, frontend]) {
    if (!child.pid) continue;
    if (process.platform === 'win32')
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
for (const child of [backend, frontend]) {
  child.on('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log(
  '\nAgosPH local workspace: http://127.0.0.1:5173\nBackend API and documentation: http://127.0.0.1:8000/docs\nPress Ctrl+C to stop both servers.\n',
);
