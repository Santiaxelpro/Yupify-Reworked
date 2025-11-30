const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// Detectar si estamos en modo desarrollo
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false
    },
    icon: path.join(__dirname, 'frontend/public/favicon.ico')
  });

  // Load URL basado en dev o producción
  const startUrl = isDev
    ? 'http://localhost:5173' // Vite dev server
    : `file://${path.join(__dirname, 'frontend/dist/index.html')}`; // Build producción

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Menú
const template = [
  {
    label: 'Archivo',
    submenu: [
      {
        label: 'Salir',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.quit();
        }
      }
    ]
  },
  {
    label: 'Editar',
    submenu: [
      { label: 'Deshacer', accelerator: 'CmdOrCtrl+Z', selector: 'undo:' },
      { label: 'Rehacer', accelerator: 'Shift+CmdOrCtrl+Z', selector: 'redo:' },
      { type: 'separator' },
      { label: 'Cortar', accelerator: 'CmdOrCtrl+X', selector: 'cut:' },
      { label: 'Copiar', accelerator: 'CmdOrCtrl+C', selector: 'copy:' },
      { label: 'Pegar', accelerator: 'CmdOrCtrl+V', selector: 'paste:' }
    ]
  },
  {
    label: 'Ver',
    submenu: [
      {
        label: 'DevTools',
        accelerator: isDev ? 'CmdOrCtrl+Shift+I' : '',
        click: () => {
          if (mainWindow) mainWindow.webContents.toggleDevTools();
        }
      }
    ]
  }
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
