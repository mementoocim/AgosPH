// Starts the Vite app on 5176 and points its /api proxy at the backend on 8001.
import { spawn } from 'node:child_process';

const child = spawn('npm.cmd', ['run', 'dev', '--', '--port', '5176'], {
  cwd: 'C:/Users/Mico/Desktop/AgosPH/frontend',
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, AGOS_BACKEND_URL: 'http://127.0.0.1:8001' },
});
child.on('exit', (code) => process.exit(code ?? 0));
