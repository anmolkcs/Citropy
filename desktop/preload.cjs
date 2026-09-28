const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("citropyDesktop", {
  environmentsState: () => ipcRenderer.invoke("environments:state"),
  sshHosts: () => ipcRenderer.invoke("environments:hosts"),
  saveEnvironment: (connection) => ipcRenderer.invoke("environments:save", connection),
  configureProjectDefaults: (settings) => ipcRenderer.invoke("environments:project-defaults", settings),
  connectEnvironment: (id) => ipcRenderer.invoke("environments:connect", id),
  disconnectEnvironment: (id) => ipcRenderer.invoke("environments:disconnect", id),
  stopEnvironment: (id) => ipcRenderer.invoke("environments:stop", id),
  removeEnvironment: (id) => ipcRenderer.invoke("environments:remove", id),
  chooseWorkspaceFolder: (id, path) => ipcRenderer.invoke("environments:choose-folder", { id, path }),
  listWorkspaceFolder: (id, path) => ipcRenderer.invoke("environments:list-folder", { id, path }),
  onEnvironmentsState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on("environments:state", listener);
    return () => ipcRenderer.removeListener("environments:state", listener);
  },
  updateState: () => ipcRenderer.invoke("updates:state"),
  updateCommand: (action) => ipcRenderer.invoke("updates:command", action),
  releaseHistory: () => ipcRenderer.invoke("updates:history"),
  onUpdateState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on("updates:state", listener);
    return () => ipcRenderer.removeListener("updates:state", listener);
  },
  windowState: () => ipcRenderer.invoke("window:state"),
  windowCommand: (command) => ipcRenderer.invoke("window:command", command),
  captureWindow: () => ipcRenderer.invoke("window:capture"),
  titlebarHeight: (height) => ipcRenderer.send("window:titlebar-height", height),
  onWindowState: (callback) => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on("window:state", listener);
    return () => ipcRenderer.removeListener("window:state", listener);
  },
  onNotification: (callback) => {
    const listener = (_, notification) => callback(notification);
    ipcRenderer.on("notification:open", listener);
    return () => ipcRenderer.removeListener("notification:open", listener);
  },
  onBrowserSelect: (callback) => {
    const listener = (_, panel) => callback(panel);
    ipcRenderer.on("browser:select", listener);
    ipcRenderer.send("browser:ready");
    return () => ipcRenderer.removeListener("browser:select", listener);
  },
  browserBounds: (id, bounds, visible, cover = false) =>
    ipcRenderer.send("browser:bounds", { id, bounds, visible, cover }),
  onBrowserCover: (callback) => {
    const listener = (_, id, image) => callback(id, image);
    ipcRenderer.on("browser:cover", listener);
    return () => ipcRenderer.removeListener("browser:cover", listener);
  },
  onAddressFocus: (callback) => {
    const listener = (_, id) => callback(id);
    ipcRenderer.on("browser:address", listener);
    return () => ipcRenderer.removeListener("browser:address", listener);
  },
});
