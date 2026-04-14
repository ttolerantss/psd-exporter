const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Increase memory limit for large PSD files (4GB)
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// Get the correct path for the app icon
function getIconPath() {
  const possiblePaths = [
    path.join(process.resourcesPath, 'icon.ico'),
    path.join(__dirname, '../assets/logol.ico'),
    path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'logol.ico'),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }

  return possiblePaths[0];
}

function createWindow() {
  // Remove the menu bar
  Menu.setApplicationMenu(null);

  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    title: 'LiveryLab Export',
    icon: getIconPath(),
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // F12 to open DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Handle external links - open in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Helper to get the main window
function getMainWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
}

// IPC: Window controls
ipcMain.on('minimize-window', () => {
  const win = getMainWindow();
  if (win) win.minimize();
});

ipcMain.on('maximize-window', () => {
  const win = getMainWindow();
  if (win) {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }
});

ipcMain.on('close-window', () => {
  const win = getMainWindow();
  if (win) win.close();
});

// IPC: Open PSD file dialog
ipcMain.handle('open-psd-dialog', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select PSD File',
    filters: [
      { name: 'Photoshop Files', extensions: ['psd'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// IPC: Get app version
ipcMain.handle('get-app-version', () => app.getVersion());

// IPC: Select output directory
ipcMain.handle('select-output-directory', async (event, defaultPath) => {
  const result = await dialog.showOpenDialog({
    title: 'Select Output Folder',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});
