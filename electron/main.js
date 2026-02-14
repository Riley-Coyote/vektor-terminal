import { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } from 'electron';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';
import net from 'net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 8088;
const SERVER_URL = `http://localhost:${PORT}`;

let mainWindow = null;
let serverProcess = null;
let tray = null;
let isQuitting = false;

// ── App Icon ──
function getIconPath() {
  const iconName = process.platform === 'darwin' ? 'icon.png' : 'icon.png';
  const iconPath = join(ROOT, 'build', iconName);
  return existsSync(iconPath) ? iconPath : null;
}

// ── Server Management ──
function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function waitForServer(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`${SERVER_URL}/health`);
      if (resp.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function startServer() {
  // Check if server is already running and healthy
  const inUse = await isPortInUse(PORT);
  if (inUse) {
    console.log(`⏀ Port ${PORT} in use — checking if it's our server...`);
    const healthy = await waitForServer(3);
    if (healthy) {
      console.log(`⏀ Existing server is healthy, reusing it`);
      return true;
    }
    console.log(`⏀ Port in use but not healthy — attempting to proceed anyway`);
    return true;
  }

  return new Promise((resolve, reject) => {
    // Find system Node.js path (not the Electron binary)
    const nodePaths = [
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      process.env.HOME + '/.nvm/versions/node/' + (process.env.NODE_VERSION || '') + '/bin/node',
    ];

    // Try to find node via PATH or common locations
    let nodePath = 'node';
    for (const p of nodePaths) {
      if (existsSync(p)) { nodePath = p; break; }
    }

    // Also check NVM current
    try {
      const nvmNode = join(process.env.HOME || '', '.nvm/versions/node');
      if (existsSync(nvmNode)) {
        const versions = readdirSync(nvmNode).sort().reverse();
        for (const v of versions) {
          const p = join(nvmNode, v, 'bin/node');
          if (existsSync(p)) { nodePath = p; break; }
        }
      }
    } catch { /* use default */ }

    console.log(`[server] Starting with node: ${nodePath}`);

    serverProcess = spawn(nodePath, [join(ROOT, 'server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      console.log(`[server] ${msg}`);
      if (msg.includes('Ready') && !started) {
        started = true;
        resolve(true);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const errMsg = data.toString().trim();
      console.error(`[server:err] ${errMsg}`);
      // If port is in use, just connect to existing server
      if (errMsg.includes('EADDRINUSE') && !started) {
        console.log(`[server] Port already in use — connecting to existing server`);
        started = true;
        serverProcess = null;
        resolve(true);
      }
    });

    serverProcess.on('error', (err) => {
      console.error(`[server] Failed to start: ${err.message}`);
      if (!started) reject(err);
    });

    serverProcess.on('exit', (code) => {
      console.log(`[server] Exited with code ${code}`);
      const wasOurProcess = serverProcess !== null;
      serverProcess = null;
      // Only show error if we started the server and it crashed unexpectedly
      if (!isQuitting && wasOurProcess && mainWindow && code !== 0) {
        dialog.showErrorBox(
          'Server Error',
          'The Vektor server process exited unexpectedly. The app will close.'
        );
        app.quit();
      }
    });

    // Timeout — if server doesn't start in 10s, try connecting anyway
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(true);
      }
    }, 10000);
  });
}

function stopServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    // Force kill after 3s
    setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill('SIGKILL');
        serverProcess = null;
      }
    }, 3000);
  }
}

// ── Window Management ──
function createWindow() {
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 500,
    title: '⏀ VEKTOR',
    titleBarStyle: 'hiddenInset', // Native macOS traffic lights
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#1a1d23',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    show: false, // Show after ready-to-show
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
    ...(iconPath && { icon: nativeImage.createFromPath(iconPath) }),
  });

  // Show window once content is loaded (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Load the local server
  mainWindow.loadURL(SERVER_URL);

  // Handle failed loads (server not ready yet)
  mainWindow.webContents.on('did-fail-load', (event, code, desc) => {
    console.log(`[window] Load failed (${code}): ${desc} — retrying in 1s...`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(SERVER_URL);
      }
    }, 1000);
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Minimize to tray on close (macOS behavior)
  mainWindow.on('close', (e) => {
    if (!isQuitting && process.platform === 'darwin') {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Tray ──
function createTray() {
  // Create a small tray icon (16x16 template image for macOS)
  const iconPath = getIconPath();
  let trayIcon;

  if (iconPath) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
    if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  } else {
    // Fallback: create a tiny canvas icon
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Vektor Terminal');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Vektor',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
    }
  });
}

// ── macOS Menu ──
function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App Lifecycle ──
app.whenReady().then(async () => {
  createMenu();

  try {
    await startServer();
  } catch (err) {
    console.error('Failed to start server:', err);
    dialog.showErrorBox(
      'Startup Error',
      `Could not start the Vektor server.\n\n${err.message}\n\nMake sure Node.js is installed and the Clawdbot gateway is running.`
    );
    app.quit();
    return;
  }

  createWindow();
  createTray();
});

app.on('activate', () => {
  // macOS: re-create window when dock icon is clicked
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  stopServer();
});

// Don't quit when all windows are closed (macOS convention — lives in tray)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});
