const { app, BrowserWindow, ipcMain, shell, session, safeStorage, clipboard } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { CryptoPSBT, URRegistryDecoder } = require('@keystonehq/bc-ur-registry')
const QRCode = require('qrcode')

const WALLET_NAME = 'FRIO-AirGap-Watch'
const GLOBAL_METHODS = new Set([
  'getblockchaininfo', 'getblockhash', 'getblock', 'getnetworkinfo', 'deriveaddresses', 'listwallets',
  'listwalletdir', 'loadwallet', 'createwallet', 'getdescriptorinfo',
  'validateaddress', 'decodepsbt', 'decoderawtransaction', 'decodescript', 'getrawtransaction', 'finalizepsbt', 'sendrawtransaction'
])
const WALLET_METHODS = new Set([
  'getwalletinfo', 'getbalance', 'getbalances', 'gettransaction',
  'listtransactions', 'listunspent', 'importdescriptors', 'listdescriptors',
  'walletcreatefundedpsbt'
])
const qrEncoders = new Map()
const qrDecoders = new Map()
const qrOptions = { width: 360, margin: 2, errorCorrectionLevel: 'M' }
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const SETTINGS_FILE = 'connection-settings.json'

function decodeBase58(value) {
  let number = 0n
  for (const character of value) {
    const digit = BASE58.indexOf(character)
    if (digit < 0) throw new Error('AirGap returned an invalid extended public key.')
    number = number * 58n + BigInt(digit)
  }
  let hex = number.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex')
  let leadingZeroes = 0
  while (value[leadingZeroes] === '1') leadingZeroes += 1
  return Buffer.concat([Buffer.alloc(leadingZeroes), body])
}

function encodeBase58(bytes) {
  let leadingZeroes = 0
  while (bytes[leadingZeroes] === 0) leadingZeroes += 1
  let number = BigInt(`0x${bytes.toString('hex')}`)
  let encoded = ''
  while (number > 0n) {
    const remainder = Number(number % 58n)
    encoded = BASE58[remainder] + encoded
    number /= 58n
  }
  return '1'.repeat(leadingZeroes) + encoded
}

function sha256d(value) {
  return createHash('sha256').update(createHash('sha256').update(value).digest()).digest()
}

function normalizeExtendedPubKey(value) {
  if (typeof value !== 'string' || value.length > 120 || !/^(?:xpub|zpub)/.test(value)) {
    throw new Error('AirGap must export a mainnet xpub or native-SegWit zpub.')
  }
  const decoded = decodeBase58(value)
  if (decoded.length !== 82) throw new Error('AirGap returned an invalid extended public key length.')
  const payload = Buffer.from(decoded.subarray(0, 78))
  const checksum = decoded.subarray(78)
  if (!timingSafeEqual(checksum, sha256d(payload).subarray(0, 4))) {
    throw new Error('AirGap returned an extended public key with a bad checksum.')
  }
  const version = payload.readUInt32BE(0)
  if (value.startsWith('xpub') && version === 0x0488b21e) return value
  if (value.startsWith('zpub') && version === 0x04b24746) {
    // Descriptors express the script type with wpkh(); Core expects the BIP32 xpub version.
    payload.writeUInt32BE(0x0488b21e, 0)
    return encodeBase58(Buffer.concat([payload, sha256d(payload).subarray(0, 4)]))
  }
  throw new Error('AirGap key prefix and extended public key version do not match.')
}

function outputDescriptorFromUr(output) {
  const hdKey = output?.getHDKey?.()
  const expressions = output?.getScriptExpressions?.()?.map(expression => expression.getExpression()) || []
  if (!hdKey || hdKey.isPrivateKey?.() || expressions.length !== 1 || expressions[0] !== 'wpkh') return ''
  const key = hdKey.getBip32Key?.()
  if (!key) return ''
  let keyExpression = key
  const origin = hdKey.getOrigin?.()
  if (origin) {
    const fingerprint = origin.getSourceFingerprint?.()?.toString('hex')
    const path = origin.getPath?.()
    if (!fingerprint || !path) return ''
    keyExpression = `[${fingerprint}/${path}]${keyExpression}`
  }
  const children = hdKey.getChildren?.()?.getPath?.()
  if (children) keyExpression += `/${children}`
  return `wpkh(${keyExpression})`
}

function secureStorageAvailable() {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend?.()
    return Boolean(backend && backend !== 'basic_text' && backend !== 'unknown')
  }
  return true
}

async function loadConnectionSettings() {
  const defaults = { rpcUrl: 'http://127.0.0.1:51777', username: '', password: '', autoConnect: true }
  try {
    const file = path.join(app.getPath('userData'), SETTINGS_FILE)
    const stored = JSON.parse(await fs.readFile(file, 'utf8'))
    let credentials = {}
    if (secureStorageAvailable() && typeof stored.encryptedCredentials === 'string') {
      try { credentials = JSON.parse(safeStorage.decryptString(Buffer.from(stored.encryptedCredentials, 'base64'))) } catch { /* Ignore unreadable saved credentials. */ }
    }
    return {
      rpcUrl: typeof stored.rpcUrl === 'string' ? stored.rpcUrl : defaults.rpcUrl,
      username: typeof credentials.username === 'string' ? credentials.username : '',
      password: typeof credentials.password === 'string' ? credentials.password : '',
      autoConnect: Boolean(stored.autoConnect && credentials.username && credentials.password)
    }
  } catch {
    return defaults
  }
}

async function saveConnectionSettings(settings) {
  const rpcUrl = String(settings?.rpcUrl || '').trim()
  localRpcUrl(rpcUrl)
  const username = String(settings?.username || '').trim()
  const password = String(settings?.password || '')
  if (!username || !password) throw new Error('Enter the node username and password before saving auto-connect settings.')
  if (username.length > 256 || password.length > 4096) throw new Error('The RPC credentials exceed the supported length.')
  if (!secureStorageAvailable()) throw new Error('Secure system storage is unavailable, so the RPC password cannot be saved for auto-connect.')
  const encryptedCredentials = safeStorage.encryptString(JSON.stringify({ username, password })).toString('base64')
  const file = path.join(app.getPath('userData'), SETTINGS_FILE)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ rpcUrl, encryptedCredentials, autoConnect: Boolean(settings.autoConnect) }, null, 2), { mode: 0o600 })
  return { saved: true, autoConnect: Boolean(settings.autoConnect) }
}

function localRpcUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Enter a valid local RPC URL.') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
      url.port !== '51777' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('For safety, this app only connects to the local Friotaíoch node at 127.0.0.1:51777.')
  }
  return url
}

async function rpc({ url: rawUrl, username, password, method, params = [], walletName }) {
  if (!GLOBAL_METHODS.has(method) && !WALLET_METHODS.has(method)) throw new Error('This RPC method is not enabled in the desktop app.')
  const selectedWalletName = walletName || WALLET_NAME
  if (WALLET_METHODS.has(method) && !/^FRIO-AirGap-Watch(?:-[a-f0-9]{16})?$/.test(selectedWalletName)) throw new Error('Unexpected watch-only wallet name.')
  if (['loadwallet', 'createwallet'].includes(method) && !/^FRIO-AirGap-Watch(?:-[a-f0-9]{16})?$/.test(params[0])) throw new Error('Unexpected watch-only wallet name.')
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    throw new Error('Enter your local node RPC username and password.')
  }
  const base = localRpcUrl(rawUrl)
  const endpoint = WALLET_METHODS.has(method)
    ? new URL(`/wallet/${encodeURIComponent(selectedWalletName)}`, base)
    : base
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${username.trim()}:${password}`, 'utf8').toString('base64')}`
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'frio-airgap-wallet', method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(method === 'importdescriptors' ? 300000 : 60000)
    })
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('The node did not respond in time. It may still be scanning the wallet.')
    throw new Error('Could not reach Friotaíoch Core. Check that it is running and RPC is enabled.')
  }
  if (response.status === 401) throw new Error('RPC login failed. Check the username and password in Friotaíoch Core.')
  let packet
  try { packet = await response.json() } catch { throw new Error(`The node returned an unreadable response (${response.status}).`) }
  if (packet.error) throw new Error(packet.error.message || 'Friotaíoch Core returned an RPC error.')
  if (!response.ok) throw new Error(`The node returned HTTP ${response.status}.`)
  return packet.result
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0b0e12',
    title: 'Friotaíoch AirGap Wallet',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => {
    const allowed = pathToFileURL(path.join(__dirname, '..', 'index.html')).href
    if (!target.startsWith(allowed)) event.preventDefault()
  })
  window.loadFile(path.join(__dirname, '..', 'index.html'))
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const localApp = contents.getURL().startsWith(pathToFileURL(path.join(__dirname, '..', 'index.html')).href)
    const videoOnly = details?.mediaTypes?.includes('video') || permission === 'media'
    callback(permission === 'media' && videoOnly && localApp)
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => {
    const localApp = contents?.getURL().startsWith(pathToFileURL(path.join(__dirname, '..', 'index.html')).href)
    return permission === 'media' && localApp && origin.startsWith('file:')
  })
  ipcMain.handle('frio:rpc', (_event, request) => rpc(request))
  ipcMain.handle('frio:wallet-name-for-account', (_event, descriptor) => {
    if (typeof descriptor !== 'string' || descriptor.length > 1000 || !/^wpkh\(/i.test(descriptor)) throw new Error('Invalid public account descriptor.')
    const suffix = createHash('sha256').update(descriptor).digest('hex').slice(0, 16)
    return `${WALLET_NAME}-${suffix}`
  })
  ipcMain.handle('frio:clipboard-write', (_event, value) => {
    if (typeof value !== 'string' || value.length > 50_000) throw new Error('Clipboard text is invalid or too long.')
    clipboard.writeText(value)
    return true
  })
  ipcMain.handle('frio:settings-load', () => loadConnectionSettings())
  ipcMain.handle('frio:settings-save', (_event, settings) => saveConnectionSettings(settings))
  ipcMain.handle('frio:qr-address', (_event, address) => QRCode.toDataURL(address, { width: 198, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101512', light: '#f4f6f0' } }))
  ipcMain.handle('frio:qr-create-signing', async (_event, psbtBase64) => {
    if (typeof psbtBase64 !== 'string' || psbtBase64.length > 2_000_000) throw new Error('The PSBT payload is invalid or too large.')
    const id = randomUUID()
    const encoder = new CryptoPSBT(Buffer.from(psbtBase64, 'base64')).toUREncoder(100)
    qrEncoders.set(id, encoder)
    const frame = encoder.nextPart()
    return { id, dataUrl: await QRCode.toDataURL(frame, qrOptions) }
  })
  ipcMain.handle('frio:qr-create-single-signing', async (_event, psbtBase64) => {
    if (typeof psbtBase64 !== 'string' || psbtBase64.length > 2_000_000) throw new Error('The PSBT payload is invalid or too large.')
    const psbt = Buffer.from(psbtBase64, 'base64')
    if (psbt.length < 6 || !psbt.subarray(0, 5).equals(Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]))) throw new Error('The node did not provide a valid PSBT.')
    if (psbt.length > 1_500) throw new Error('This transaction is too large for a readable one-frame QR. Use the animated QR instead.')
    const encoder = new CryptoPSBT(psbt).toUREncoder(4_096)
    if (encoder.fragmentsLength !== 1) throw new Error('This transaction needs more than one UR fragment. Use the animated QR instead.')
    const frame = encoder.nextPart()
    const qr = QRCode.create(frame, { errorCorrectionLevel: 'M' })
    if (qr.version > 30) throw new Error('This one-frame QR would be too dense for a reliable phone scan. Use the animated QR instead.')
    return QRCode.toDataURL(frame, { width: 640, margin: 4, errorCorrectionLevel: 'M' })
  })
  ipcMain.handle('frio:qr-next-signing', async (_event, id) => {
    const encoder = qrEncoders.get(id)
    if (!encoder) throw new Error('The QR session has expired.')
    return QRCode.toDataURL(encoder.nextPart(), qrOptions)
  })
  ipcMain.handle('frio:qr-stop-signing', (_event, id) => { qrEncoders.delete(id) })
  ipcMain.handle('frio:qr-begin-scan', () => {
    const id = randomUUID()
    qrDecoders.set(id, new URRegistryDecoder())
    return id
  })
  ipcMain.handle('frio:qr-read-frame', (_event, { id, frame }) => {
    const decoder = qrDecoders.get(id)
    if (!decoder) throw new Error('The QR scan session has expired.')
    if (typeof frame !== 'string' || frame.length > 100_000) throw new Error('The scanned QR frame is invalid.')
    if (!frame.toLowerCase().startsWith('ur:')) return { done: true, type: 'text', payload: frame }
    const type = frame.slice(3).split('/')[0].toLowerCase()
    const accepted = decoder.receivePart(frame)
    if (decoder.isError()) {
      qrDecoders.delete(id)
      return { done: true, type: 'error', urType: type, error: decoder.resultError() }
    }
    if (!decoder.isComplete()) return {
      done: false, type, accepted,
      progress: decoder.getProgress(),
      receivedParts: decoder.receivedPartIndexes().length,
      expectedParts: decoder.expectedPartCount()
    }
    const item = decoder.resultRegistryType()
    qrDecoders.delete(id)
    if (typeof item.getPSBT === 'function') return { done: true, type: 'psbt', payload: item.getPSBT().toString('base64') }
    const outputs = item.getOutputDescriptors?.() || [item]
    const descriptor = outputs.map(output => outputDescriptorFromUr(output) || output.toString?.() || '').find(value => /wpkh\(/i.test(value))
    if (descriptor) return { done: true, type: 'descriptor', payload: descriptor }
    return { done: true, type: 'unsupported', payload: item.getRegistryType?.().getType?.() || 'unsupported UR type' }
  })
  ipcMain.handle('frio:qr-end-scan', (_event, id) => { qrDecoders.delete(id) })
  ipcMain.handle('frio:normalize-account-key', (_event, key) => normalizeExtendedPubKey(key))
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

ipcMain.on('frio:open-external', (_event, url) => {
  if (url === 'https://www.friotaioch.com/' || url === 'https://support.airgap.it/' || /^https:\/\/explorer\.friotaioch\.com\/tx\/[0-9a-f]{64}$/i.test(String(url))) shell.openExternal(url)
})
