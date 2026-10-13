const { app, BrowserWindow, ipcMain, shell, session, safeStorage, clipboard, Menu, Tray } = require('electron')
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
const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href
const ICON_DIRECTORY = app.isPackaged
  ? path.join(process.resourcesPath, 'icons')
  : path.join(__dirname, '..', 'assets', 'icons')
let tray = null

function isTrustedIpcEvent(event) {
  return Boolean(event?.senderFrame && event.senderFrame === event.sender?.mainFrame && event.senderFrame.url === APP_URL)
}

function handleTrustedIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcEvent(event)) throw new Error('This request did not come from the wallet window.')
    return handler(...args)
  })
}

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
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || typeof settings.autoConnect !== 'boolean') {
    throw new Error('The node connection settings are invalid.')
  }
  if (typeof settings.rpcUrl !== 'string' || typeof settings.username !== 'string' || typeof settings.password !== 'string') {
    throw new Error('The node connection settings are invalid.')
  }
  const rpcUrl = settings.rpcUrl.trim()
  localRpcUrl(rpcUrl)
  const username = settings.username.trim()
  const password = settings.password
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
  if (url.protocol !== 'http:' || url.username || url.password || !['127.0.0.1', 'localhost', '[::1]'].includes(host) ||
      url.port !== '51777' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('For safety, this app only connects to the local Friotaíoch node at 127.0.0.1:51777.')
  }
  return url
}

function validateDescriptorImport(params) {
  if (!Array.isArray(params) || params.length !== 1 || !Array.isArray(params[0]) || params[0].length < 1 || params[0].length > 2) {
    throw new Error('Only the paired public BIP84 account descriptors may be imported.')
  }
  const branches = new Set()
  for (const item of params[0]) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some(key => !['desc', 'timestamp', 'active', 'internal', 'range'].includes(key)) ||
        typeof item.desc !== 'string' || item.timestamp !== 0 || item.active !== true || typeof item.internal !== 'boolean' ||
        !Array.isArray(item.range) || item.range.length !== 2 || item.range[0] !== 0 ||
        !Number.isInteger(item.range[1]) || item.range[1] < 0 || item.range[1] > 1_000_000) {
      throw new Error('The public BIP84 descriptor import request is invalid.')
    }
    const match = item.desc.match(/^wpkh\(\[([0-9a-f]{8})\/84'\/0'\/0'\](xpub[1-9A-HJ-NP-Za-km-z]{100,120})\/(0|1)\/\*\)#[0-9a-z]{8}$/i)
    if (!match || (match[3] === '1') !== item.internal) throw new Error('Private keys and non-BIP84 descriptors cannot be imported into this wallet.')
    if (normalizeExtendedPubKey(match[2]) !== match[2]) throw new Error('Only a valid mainnet extended public key can be imported.')
    if (branches.has(match[3])) throw new Error('A duplicate BIP84 descriptor branch cannot be imported.')
    branches.add(match[3])
  }
}

function validateFundedPsbtRequest(params) {
  if (!Array.isArray(params) || ![5, 7].includes(params.length) ||
      !Array.isArray(params[0]) || params[0].length > 1_000 ||
      !params[1] || typeof params[1] !== 'object' || Array.isArray(params[1]) || Object.keys(params[1]).length !== 1 ||
      params[2] !== 0 || !params[3] || typeof params[3] !== 'object' || Array.isArray(params[3]) || params[4] !== true ||
      (params.length === 7 && (params[5] !== 2 || params[6] !== 0))) {
    throw new Error('Only the wallet transfer PSBT request format is enabled.')
  }
  for (const input of params[0]) {
    if (!input || typeof input !== 'object' || !/^[0-9a-f]{64}$/i.test(input.txid || '') ||
        !Number.isInteger(input.vout) || input.vout < 0 ||
        (input.sequence !== undefined && (!Number.isInteger(input.sequence) || input.sequence < 0 || input.sequence > 0xffffffff)) ||
        Object.keys(input).some(key => !['txid', 'vout', 'sequence'].includes(key))) {
      throw new Error('The wallet transfer input list is invalid.')
    }
  }
  const seenInputs = new Set(params[0].map(input => `${input.txid.toLowerCase()}:${input.vout}`))
  if (seenInputs.size !== params[0].length) throw new Error('The wallet transfer contains a duplicate input.')
  const [recipient, amount] = Object.entries(params[1])[0]
  if (!/^frio1[qp][a-z0-9]{20,90}$/i.test(recipient) || typeof amount !== 'number' || !Number.isFinite(amount) ||
      amount <= 0 || Math.round(amount * 100_000_000) > Number.MAX_SAFE_INTEGER ||
      Math.round(amount * 100_000_000) / 100_000_000 !== amount) {
    throw new Error('The wallet transfer recipient or amount is invalid.')
  }
  const options = params[3]
  const optionKeys = Object.keys(options)
  if (optionKeys.some(key => !['includeWatching', 'add_inputs', 'changePosition', 'fee_rate', 'feeRate', 'changeAddress'].includes(key)) ||
      options.includeWatching !== true || typeof options.add_inputs !== 'boolean' || options.changePosition !== 1 ||
      (options.fee_rate !== undefined && options.feeRate !== undefined) ||
      (options.fee_rate !== undefined && (!Number.isFinite(options.fee_rate) || options.fee_rate < 0.1 || options.fee_rate > 1000)) ||
      (options.feeRate !== undefined && (!Number.isFinite(options.feeRate) || options.feeRate < 0.000001 || options.feeRate > 0.01)) ||
      (options.fee_rate === undefined && options.feeRate === undefined) ||
      (options.changeAddress !== undefined && !/^frio1q[a-z0-9]{20,90}$/i.test(options.changeAddress))) {
    throw new Error('The wallet transfer fee and change options are invalid.')
  }
}

async function rpc(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid local node request.')
  const { url: rawUrl, username, password, method, params = [], walletName } = request
  if (!GLOBAL_METHODS.has(method) && !WALLET_METHODS.has(method)) throw new Error('This RPC method is not enabled in the desktop app.')
  if (!Array.isArray(params) || params.length > 100) throw new Error('The local node request parameters are invalid.')
  let encodedParams
  try { encodedParams = JSON.stringify(params) } catch { throw new Error('The local node request parameters are invalid.') }
  if (encodedParams.length > 5_000_000) throw new Error('The local node request is too large.')
  const selectedWalletName = walletName || WALLET_NAME
  if (WALLET_METHODS.has(method) && !/^FRIO-AirGap-Watch(?:-[a-f0-9]{16})?$/.test(selectedWalletName)) throw new Error('Unexpected watch-only wallet name.')
  if (['loadwallet', 'createwallet'].includes(method) && !/^FRIO-AirGap-Watch(?:-[a-f0-9]{16})?$/.test(params[0] || '')) throw new Error('Unexpected watch-only wallet name.')
  if (method === 'loadwallet' && params.length !== 1) throw new Error('Only the named wallet may be loaded.')
  if (method === 'createwallet' && (params.length !== 6 || params[1] !== true || params[2] !== true || params[3] !== '' || params[4] !== false || params[5] !== true)) {
    throw new Error('Only a blank, descriptor-based wallet with private keys disabled can be created.')
  }
  if (method === 'importdescriptors') validateDescriptorImport(params)
  if (method === 'walletcreatefundedpsbt') validateFundedPsbtRequest(params)
  if (method === 'decodepsbt' && (params.length !== 1 || typeof params[0] !== 'string')) throw new Error('Only one PSBT can be decoded at a time.')
  if (method === 'finalizepsbt' && (params.length !== 2 || typeof params[0] !== 'string' || params[1] !== true)) throw new Error('Only PSBT finalization for the explicit broadcast flow is enabled.')
  if (method === 'sendrawtransaction' && (params.length !== 1 || typeof params[0] !== 'string' || params[0].length > 2_000_000 || params[0].length % 2 !== 0 || !/^[0-9a-f]+$/i.test(params[0]))) {
    throw new Error('The finalized transaction payload is invalid.')
  }
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    throw new Error('Enter your local node RPC username and password.')
  }
  if (username.length > 256 || password.length > 4096) throw new Error('The RPC credentials exceed the supported length.')
  if (typeof rawUrl !== 'string') throw new Error('Enter a valid local RPC URL.')
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
    icon: path.join(ICON_DIRECTORY, process.platform === 'win32' ? 'icon.ico' : '32x32.png'),
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
    if (target !== APP_URL) event.preventDefault()
  })
  window.loadFile(path.join(__dirname, '..', 'index.html'))
}

function showMainWindow() {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function createTray() {
  if (tray) return
  const iconPath = path.join(ICON_DIRECTORY, process.platform === 'win32' ? '32x32.png' : '24x24.png')
  tray = new Tray(iconPath)
  tray.setToolTip('Friotaíoch AirGap Wallet')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show wallet', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const localApp = contents.getURL() === APP_URL
    const mediaTypes = Array.isArray(details?.mediaTypes) ? details.mediaTypes : []
    const videoOnly = mediaTypes.includes('video') && !mediaTypes.includes('audio')
    callback(permission === 'media' && videoOnly && localApp)
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => {
    const localApp = contents?.getURL() === APP_URL
    return permission === 'media' && localApp && origin.startsWith('file:')
  })
  handleTrustedIpc('frio:rpc', request => rpc(request))
  handleTrustedIpc('frio:wallet-name-for-account', descriptor => {
    if (typeof descriptor !== 'string' || descriptor.length > 1000 || !/^wpkh\(/i.test(descriptor)) throw new Error('Invalid public account descriptor.')
    const suffix = createHash('sha256').update(descriptor).digest('hex').slice(0, 16)
    return `${WALLET_NAME}-${suffix}`
  })
  handleTrustedIpc('frio:clipboard-write', value => {
    if (typeof value !== 'string' || value.length > 50_000) throw new Error('Clipboard text is invalid or too long.')
    clipboard.writeText(value)
    return true
  })
  handleTrustedIpc('frio:settings-load', () => loadConnectionSettings())
  handleTrustedIpc('frio:settings-save', settings => saveConnectionSettings(settings))
  handleTrustedIpc('frio:qr-address', address => {
    if (typeof address !== 'string' || address.length > 100 || !/^frio1q[ac-hj-np-z02-9]{20,80}$/i.test(address)) throw new Error('The receive address is not a valid FRIO native-SegWit address.')
    return QRCode.toDataURL(address, { width: 198, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#101512', light: '#f4f6f0' } })
  })
  handleTrustedIpc('frio:qr-create-signing', async psbtBase64 => {
    const psbt = decodePsbtBase64(psbtBase64)
    const id = randomUUID()
    const encoder = new CryptoPSBT(psbt).toUREncoder(180)
    qrEncoders.set(id, encoder)
    const frame = encoder.nextPart()
    return { id, dataUrl: await QRCode.toDataURL(frame, qrOptions) }
  })
  handleTrustedIpc('frio:qr-create-single-signing', async psbtBase64 => {
    const psbt = decodePsbtBase64(psbtBase64)
    if (psbt.length > 1_500) throw new Error('This transaction is too large for a readable one-frame QR. Use the animated QR instead.')
    const encoder = new CryptoPSBT(psbt).toUREncoder(4_096)
    if (encoder.fragmentsLength !== 1) throw new Error('This transaction needs more than one UR fragment. Use the animated QR instead.')
    const frame = encoder.nextPart()
    const qr = QRCode.create(frame, { errorCorrectionLevel: 'M' })
    if (qr.version > 30) throw new Error('This one-frame QR would be too dense for a reliable phone scan. Use the animated QR instead.')
    return QRCode.toDataURL(frame, { width: 640, margin: 4, errorCorrectionLevel: 'M' })
  })
  handleTrustedIpc('frio:qr-next-signing', async id => {
    const encoder = qrEncoders.get(id)
    if (!encoder) throw new Error('The QR session has expired.')
    return QRCode.toDataURL(encoder.nextPart(), qrOptions)
  })
  handleTrustedIpc('frio:qr-stop-signing', id => { qrEncoders.delete(id) })
  handleTrustedIpc('frio:qr-begin-scan', () => {
    const id = randomUUID()
    qrDecoders.set(id, new URRegistryDecoder())
    return id
  })
  handleTrustedIpc('frio:qr-read-frame', ({ id, frame }) => {
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
  handleTrustedIpc('frio:qr-end-scan', id => { qrDecoders.delete(id) })
  handleTrustedIpc('frio:normalize-account-key', key => normalizeExtendedPubKey(key))
  createWindow()
  createTray()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault())
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

ipcMain.on('frio:open-external', (event, url) => {
  if (!isTrustedIpcEvent(event)) return
  if (url === 'https://www.friotaioch.com/' || url === 'https://support.airgap.it/' || /^https:\/\/explorer\.friotaioch\.com\/tx\/[0-9a-f]{64}$/i.test(String(url))) shell.openExternal(url)
})

app.on('before-quit', () => {
  tray?.destroy()
  tray = null
})

function decodePsbtBase64(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 2_000_000 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('The PSBT payload is invalid or too large.')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.length < 6 || !bytes.subarray(0, 5).equals(Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]))) {
    throw new Error('The node did not provide a valid PSBT.')
  }
  return bytes
}
