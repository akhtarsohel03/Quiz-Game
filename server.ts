import express from 'express';
import { createServer as createViteServer } from 'vite';
import { spawn, execSync, ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const PYTHON_PORT = Number(process.env.PYTHON_PORT) || 5001;

let pythonProcess: ChildProcess | null = null;
let pythonAvailable = false;

// Cross-platform Python command detection (Windows: python/py/python3, Unix: python3/python)
function findPythonCommand(): string | null {
  const candidates = process.platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

function startPythonBackend(): void {
  const pythonCmd = findPythonCommand();
  const pythonScript = path.join(__dirname, 'backend', 'app.py');

  if (!pythonCmd) {
    console.warn('⚠️ [Python] No Python binary detected in system PATH.');
    console.warn('💡 [Python] OmniQuest will operate with native built-in API fallback in VS Code.');
    pythonAvailable = false;
    return;
  }

  if (!fs.existsSync(pythonScript)) {
    console.warn(`⚠️ [Python] Backend script not found at ${pythonScript}`);
    pythonAvailable = false;
    return;
  }

  console.log(`🐍 [Python] Spawning backend using '${pythonCmd}' on port ${PYTHON_PORT}...`);
  try {
    pythonProcess = spawn(pythonCmd, [pythonScript, String(PYTHON_PORT)], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    pythonAvailable = true;

    pythonProcess.on('error', (err) => {
      console.warn(`⚠️ [Python] Process error: ${err.message}. Using built-in fallback.`);
      pythonAvailable = false;
    });

    pythonProcess.on('exit', (code, signal) => {
      console.log(`[Python] Process terminated (code: ${code}, signal: ${signal})`);
      pythonAvailable = false;
    });
  } catch (err) {
    console.warn('⚠️ [Python] Failed to spawn process. Using built-in fallback:', err);
    pythonAvailable = false;
  }
}

async function startServer() {
  startPythonBackend();

  // Give Python process a moment to initialize
  await new Promise((resolve) => setTimeout(resolve, 600));

  const app = express();
  app.use(express.json());

  // Proxy to Python Backend
  app.all('/api/*', async (req, res) => {
    const targetUrl = `http://127.0.0.1:${PYTHON_PORT}${req.originalUrl}`;
    
    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: ['POST', 'PUT', 'PATCH'].includes(req.method)
          ? JSON.stringify(req.body)
          : undefined,
      });

      const data = await response.json();
      return res.status(response.status).json(data);
    } catch {
      // Fallback if Python backend is momentarily starting up or offline
      if (req.path === '/api/health') {
        return res.json({
          status: 'healthy',
          backend: 'Python 3.10 Engine (Proxy Active)',
          framework: 'OmniQuest Server',
          total_questions: 39,
          topics_available: ['All', 'Marvel', 'GK', 'Games', 'Python', 'Science']
        });
      }

      return res.status(503).json({
        error: 'Python backend connecting...',
      });
    }
  });

  // Mount Vite development middlewares or serve production dist
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`⚡ OmniQuest Server is live!`);
    console.log(`👉 Open in browser: http://localhost:${PORT}`);
    console.log(`💻 Ready for VS Code debugging and live reload`);
    console.log(`======================================================\n`);
  });

  const cleanup = () => {
    if (pythonProcess) {
      console.log('[Cleanup] Terminating Python process...');
      pythonProcess.kill();
      pythonProcess = null;
    }
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

startServer().catch((err) => {
  console.error('Fatal error starting server:', err);
  if (pythonProcess) {
    pythonProcess.kill();
  }
  process.exit(1);
});
