const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'VEKTOR — Stream',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 17 },
    backgroundColor: '#1c1b1f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadURL('http://localhost:8088');

  app.on('window-all-closed', () => app.quit());
});
