const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('frioDesktop', {
  rpc: request => ipcRenderer.invoke('frio:rpc', request),
  walletNameForAccount: descriptor => ipcRenderer.invoke('frio:wallet-name-for-account', descriptor),
  copyText: value => ipcRenderer.invoke('frio:clipboard-write', value),
  loadConnectionSettings: () => ipcRenderer.invoke('frio:settings-load'),
  saveConnectionSettings: settings => ipcRenderer.invoke('frio:settings-save', settings),
  addressQr: address => ipcRenderer.invoke('frio:qr-address', address),
  createSigningQr: psbt => ipcRenderer.invoke('frio:qr-create-signing', psbt),
  createSingleSigningQr: psbt => ipcRenderer.invoke('frio:qr-create-single-signing', psbt),
  nextSigningQr: id => ipcRenderer.invoke('frio:qr-next-signing', id),
  stopSigningQr: id => ipcRenderer.invoke('frio:qr-stop-signing', id),
  beginQrScan: () => ipcRenderer.invoke('frio:qr-begin-scan'),
  readQrFrame: (id, frame) => ipcRenderer.invoke('frio:qr-read-frame', { id, frame }),
  endQrScan: id => ipcRenderer.invoke('frio:qr-end-scan', id),
  normalizeAccountKey: key => ipcRenderer.invoke('frio:normalize-account-key', key),
  openExternal: url => ipcRenderer.send('frio:open-external', url),
  walletName: 'FRIO-AirGap-Watch',
  genesisHash: '00000000908e647ce8296582a2d24023ef96a5e7d2320a5815b603463993676d'
})
