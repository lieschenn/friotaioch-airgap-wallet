const GENESIS = window.frioDesktop.genesisHash
const WALLET = window.frioDesktop.walletName
const ACCOUNT_KEY = 'frio-airgap-public-descriptor-v1'
const SAVED_ACCOUNTS_KEY = 'frio-airgap-saved-accounts-v1'
const SELECTED_ACCOUNT_ID_KEY = 'frio-airgap-selected-account-id-v1'
const IGNORED_ACCOUNT_IDS_KEY = 'frio-airgap-ignored-node-account-ids-v1'
const ACCOUNT_WALLETS_KEY = 'frio-airgap-account-wallets-v1'
const FEE_RATE_KEY = 'frio-airgap-fee-rate-sat-vb-v1'
const $ = selector => document.querySelector(selector)
const $$ = selector => [...document.querySelectorAll(selector)]
const savedWalletState = loadWalletState()
const state = {
  rpcUrl: 'http://127.0.0.1:51777', username: '', password: '', autoConnect: true, connected: false,
  accounts: savedWalletState.accounts, account: savedWalletState.account, walletName: WALLET, walletSwitching: false,
  chain: null, balance: null, transactions: [], transactionsError: '', addresses: [], addressError: '',
  currentAddress: '', currentAddressIndex: Math.max(0, Number(savedWalletState.account?.receiveIndex) || 0), selectedPage: 'overview', scanning: false, cameraControls: null,
  scanner: null, qrTimer: null, qrEncoderId: null, unsignedPsbt: null, incomingDecoderId: null,
  lastFrame: '', scanMode: null, scanGeneration: 0, qrFrameQueue: Promise.resolve(), toastTimer: null, feeRate: loadFeeRate(), activityRequestId: 0
}
state.walletName = state.account?.walletName || WALLET

function loadWalletState() {
  try {
    const accounts = JSON.parse(localStorage.getItem(SAVED_ACCOUNTS_KEY) || '[]')
    const saved = Array.isArray(accounts) ? accounts.filter(account => account && typeof account.external === 'string' && typeof account.internal === 'string') : []
    let legacyAccount = null
    try { legacyAccount = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null') } catch { /* Ignore a damaged legacy active-account record. */ }
    if (legacyAccount?.external && !saved.some(account => descriptorIdentity(account.external) === descriptorIdentity(legacyAccount.external))) saved.push(legacyAccount)
    const selectedId = localStorage.getItem(SELECTED_ACCOUNT_ID_KEY)
    const account = saved.find(item => descriptorIdentity(item.external) === selectedId)
      || saved.find(item => legacyAccount && descriptorIdentity(item.external) === descriptorIdentity(legacyAccount.external))
      || saved[0] || null
    if (account) {
      localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(saved))
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))
      localStorage.setItem(SELECTED_ACCOUNT_ID_KEY, descriptorIdentity(account.external))
    }
    return { accounts: saved, account }
  } catch { return { accounts: [], account: null } }
}
function loadFeeRate() {
  try {
    const stored = Number(localStorage.getItem(FEE_RATE_KEY))
    return Number.isFinite(stored) && stored >= 0.1 && stored <= 1000 ? stored : 1
  } catch { return 1 }
}
function saveAccount(account) {
  if (account) {
    const identity = descriptorIdentity(account.external)
    localStorage.setItem(IGNORED_ACCOUNT_IDS_KEY, JSON.stringify(loadIgnoredAccountIds().filter(value => value !== identity)))
    account = upsertSavedAccount({ ...account, walletName: account.walletName || state.walletName || WALLET })
    state.walletName = account.walletName
    state.account = account
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))
    localStorage.setItem(SELECTED_ACCOUNT_ID_KEY, descriptorIdentity(account.external))
  } else {
    if (state.account) {
      const identity = descriptorIdentity(state.account.external)
      const ignored = loadIgnoredAccountIds()
      if (!ignored.includes(identity)) localStorage.setItem(IGNORED_ACCOUNT_IDS_KEY, JSON.stringify([...ignored, identity]))
      state.accounts = state.accounts.filter(item => descriptorIdentity(item.external) !== identity)
    }
    persistSavedAccounts()
    state.account = null
    state.walletName = WALLET
    localStorage.removeItem(ACCOUNT_KEY)
    localStorage.removeItem(SELECTED_ACCOUNT_ID_KEY)
  }
  updateAccountState()
}
function persistSavedAccounts() {
  localStorage.setItem(SAVED_ACCOUNTS_KEY, JSON.stringify(state.accounts))
}
function loadIgnoredAccountIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(IGNORED_ACCOUNT_IDS_KEY) || '[]')
    return Array.isArray(ids) ? ids.filter(value => typeof value === 'string') : []
  } catch { return [] }
}
function upsertSavedAccount(account) {
  const identity = descriptorIdentity(account.external)
  const existing = state.accounts.find(item => descriptorIdentity(item.external) === identity)
  const saved = {
    ...existing,
    ...account,
    walletName: account.walletName || existing?.walletName || WALLET,
    label: account.label || existing?.label || '',
    receiveIndex: Number.isInteger(Number(account.receiveIndex)) ? Math.max(0, Number(account.receiveIndex)) : Number(existing?.receiveIndex) || 0
  }
  state.accounts = [...state.accounts.filter(item => descriptorIdentity(item.external) !== identity), saved]
  rememberAccountWallet(saved, saved.walletName)
  persistSavedAccounts()
  return saved
}
function walletDisplayLabel(account) {
  const fingerprint = String(account.fingerprint || 'unknown').toUpperCase()
  const duplicates = state.accounts.filter(item => String(item.fingerprint || '').toLowerCase() === String(account.fingerprint || '').toLowerCase()).length > 1
  return account.label || `AirGap · ${fingerprint}${duplicates && account.walletName ? ` · ${account.walletName.slice(-4)}` : ''}`
}
function loadAccountWallets() {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_WALLETS_KEY) || '{}') } catch { return {} }
}
function rememberAccountWallet(account, walletName) {
  if (!account?.external || !walletName) return
  const index = loadAccountWallets()
  index[descriptorIdentity(account.external)] = walletName
  localStorage.setItem(ACCOUNT_WALLETS_KEY, JSON.stringify(index))
}
async function walletNameForAccount(account) {
  const identity = descriptorIdentity(account.external)
  if (state.account && descriptorIdentity(state.account.external) === identity) return state.walletName || state.account.walletName || WALLET
  const known = loadAccountWallets()[identity]
  if (known) return known
  return window.frioDesktop.walletNameForAccount(account.external)
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
}
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
const BECH32M_CONST = 0x2bc830a3
function bech32HrpExpand(hrp) {
  const characters = [...hrp].map(character => character.charCodeAt(0))
  return [...characters.map(value => value >>> 5), 0, ...characters.map(value => value & 31)]
}
function bech32Polymod(values) {
  let checksum = 1
  for (const value of values) {
    const top = checksum >>> 25
    checksum = ((checksum & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index++) {
      if ((top >>> index) & 1) checksum ^= BECH32_GENERATORS[index]
    }
  }
  return checksum >>> 0
}
function bech32Checksum(hrp, data, constant = 1) {
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant
  return Array.from({ length: 6 }, (_value, index) => (polymod >>> (5 * (5 - index))) & 31)
}
function convertBits(data, fromBits, toBits, pad) {
  let accumulator = 0
  let bitCount = 0
  const result = []
  const maxValue = (1 << toBits) - 1
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1
  for (const value of data) {
    if (value < 0 || (value >>> fromBits) !== 0) return null
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator
    bitCount += fromBits
    while (bitCount >= toBits) {
      bitCount -= toBits
      result.push((accumulator >>> bitCount) & maxValue)
    }
  }
  if (pad) {
    if (bitCount) result.push((accumulator << (toBits - bitCount)) & maxValue)
  } else if (bitCount >= fromBits || ((accumulator << (toBits - bitCount)) & maxValue)) return null
  return result
}
function decodeSegwitAddress(address, expectedHrp) {
  if (typeof address !== 'string' || address.length > 90 || /[^\x21-\x7e]/.test(address)) return null
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) return null
  const normalized = address.toLowerCase()
  const separator = normalized.lastIndexOf('1')
  if (separator < 1 || separator + 7 > normalized.length || normalized.slice(0, separator) !== expectedHrp) return null
  const values = [...normalized.slice(separator + 1)].map(character => BECH32_CHARSET.indexOf(character))
  if (values.some(value => value < 0)) return null
  const checksum = bech32Polymod([...bech32HrpExpand(expectedHrp), ...values])
  const encoding = checksum === 1 ? 'bech32' : checksum === BECH32M_CONST ? 'bech32m' : null
  if (!encoding) return null
  const data = values.slice(0, -6)
  const version = data[0]
  if (!Number.isInteger(version) || version < 0 || version > 16) return null
  if ((version === 0 && encoding !== 'bech32') || (version > 0 && encoding !== 'bech32m')) return null
  const program = convertBits(data.slice(1), 5, 8, false)
  if (!program || program.length < 2 || program.length > 40) return null
  if (version === 0 && program.length !== 20 && program.length !== 32) return null
  if (version === 1 && program.length !== 32) return null
  return { hrp: expectedHrp, version, program, data, encoding }
}
function encodeSegwitAddress(hrp, version, program) {
  const words = [version, ...convertBits(program, 8, 5, true)]
  const constant = version === 0 ? 1 : BECH32M_CONST
  const checksum = bech32Checksum(hrp, words, constant)
  return `${hrp}1${[...words, ...checksum].map(value => BECH32_CHARSET[value]).join('')}`
}
function bitcoinEquivalentAddress(frioAddress) {
  const decoded = decodeSegwitAddress(frioAddress, 'frio')
  if (!decoded) return null
  return encodeSegwitAddress('bc', decoded.version, decoded.program)
}
function bitcoinToFrioAddress(bitcoinAddress) {
  const decoded = decodeSegwitAddress(bitcoinAddress, 'bc')
  if (!decoded) return null
  return encodeSegwitAddress('frio', decoded.version, decoded.program)
}
function expectedWitnessScript(decoded) {
  if (decoded.version === 0 && decoded.program.length === 20) return `0014${decoded.program.map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  if (decoded.version === 0 && decoded.program.length === 32) return `0020${decoded.program.map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  if (decoded.version === 1 && decoded.program.length === 32) return `5120${decoded.program.map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  return null
}
function addressComparisonHtml(frioAddress) {
  const bitcoinAddress = bitcoinEquivalentAddress(frioAddress)
  if (!bitcoinAddress) return `<div class="address-comparison-unavailable"><span>FRIO</span><code>${esc(frioAddress)}</code><span>BTC equivalent unavailable</span></div>`
  const sharedFrio = frioAddress.slice(5, -6)
  const sharedBitcoin = bitcoinAddress.slice(3, -6)
  if (sharedFrio !== sharedBitcoin) return `<div class="address-comparison-unavailable"><span>FRIO</span><code>${esc(frioAddress)}</code><span>BTC equivalent unavailable</span></div>`
  const frio = `<code><span class="address-exclusive-frio">frio1</span><span class="address-shared">${esc(sharedFrio)}</span><span class="address-exclusive-frio">${esc(frioAddress.slice(-6))}</span></code>`
  const bitcoin = `<code><span class="address-exclusive-bitcoin">bc1</span><span class="address-shared">${esc(sharedBitcoin)}</span><span class="address-exclusive-bitcoin">${esc(bitcoinAddress.slice(-6))}</span></code>`
  return `<div class="address-comparison" role="group" aria-label="Equivalent FRIO and Bitcoin addresses"><div class="address-comparison-line"><span class="address-network-label">FRIO</span>${frio}</div><div class="address-comparison-line"><span class="address-network-label">BTC</span>${bitcoin}</div></div>`
}
function toast(message, isError = false) {
  const el = $('#toast')
  el.textContent = message
  el.classList.toggle('error', isError)
  el.classList.add('show')
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 3300)
}
function formatFrio(amount, digits = 8) {
  const num = Number(amount)
  if (!Number.isFinite(num)) return '—'
  return num.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: digits })
}
function rpc(method, params = [], wallet = false, walletName = state.walletName || WALLET) {
  if (!state.username || !state.password) throw new Error('Enter your local node RPC login in Settings.')
  return window.frioDesktop.rpc({
    url: state.rpcUrl, username: state.username, password: state.password,
    method, params, ...(wallet ? { walletName } : {})
  })
}
async function persistConnectionSettings() {
  try {
    await window.frioDesktop.saveConnectionSettings({
      rpcUrl: state.rpcUrl, username: state.username, password: state.password, autoConnect: state.autoConnect
    })
    return true
  } catch (error) {
    toast(`Connected, but saved auto-connect settings could not be updated: ${error.message}`, true)
    return false
  }
}

async function restoreConnectionSettings() {
  try {
    const saved = await window.frioDesktop.loadConnectionSettings()
    state.rpcUrl = saved.rpcUrl || 'http://127.0.0.1:51777'
    state.username = saved.username || ''
    state.password = saved.password || ''
    state.autoConnect = Boolean(saved.autoConnect)
    $('#rpcUrl').value = state.rpcUrl
    $('#rpcUser').value = state.username
    $('#rpcPassword').value = state.password
    $('#autoConnect').checked = state.autoConnect
    if (state.autoConnect && state.username && state.password) {
      await connectNode()
      toast('Reconnected to your local Friotaíoch node.')
    }
  } catch (error) {
    connectedUi(false)
    toast(`Saved node connection failed: ${error.message}`, true)
  }
}
function connectedUi(connected) {
  state.connected = connected
  const color = connected ? '#43b985' : '#75817b'
  $('#nodeDot').style.background = color
  $('#sidebarDot').style.background = color
  $('#nodeStatus').textContent = connected ? 'FRIO node connected' : 'Node offline'
  $('#sidebarStatus').textContent = connected ? 'Connected' : 'Not connected'
  $('#settingsNodeState').textContent = connected ? 'Connected' : 'Not connected'
  $('#setupBanner').classList.toggle('hidden-banner', connected && !!state.account)
}
function updateAccountState() {
  const paired = !!state.account
  $('#accountBadge').textContent = paired ? 'Paired' : 'Not paired'
  $('#accountBadge').style.color = paired ? '#54ca94' : ''
  $('#settingsAccountState').textContent = paired ? 'Paired' : 'Not paired'
  $('#walletMode').textContent = paired ? 'Watch-only · no private keys' : 'No account paired'
  $('#activeWalletName').textContent = paired ? walletDisplayLabel(state.account) : 'AirGap SegWit'
  if (paired) {
    $('#accountPath').textContent = `BIP84 · m/84′/0′/0′ · ${state.account.fingerprint.toUpperCase()}`
    $('#prepareButton').disabled = !state.connected
  } else {
    $('#accountPath').textContent = 'BIP84 · m/84′/0′/0′'
    $('#prepareButton').disabled = true
  }
  $('#setupBanner').classList.toggle('hidden-banner', paired && state.connected)
  renderWalletSelector()
}
function renderWalletSelector() {
  const selector = $('#walletSelector')
  if (!selector) return
  const shouldShow = state.accounts.length > 1 || (state.accounts.length > 0 && !state.account)
  selector.hidden = !shouldShow
  selector.disabled = state.walletSwitching
  if (!shouldShow) { selector.innerHTML = ''; return }
  const selectedIdentity = state.account ? descriptorIdentity(state.account.external) : ''
  selector.innerHTML = `<option value="">Select a saved wallet…</option>${state.accounts.map(account => `<option value="${esc(descriptorIdentity(account.external))}">${esc(walletDisplayLabel(account))}</option>`).join('')}`
  selector.value = selectedIdentity
}
function clearWalletData(receiveIndex = 0) {
  state.unsignedPsbt = null
  state.signedPsbt = null
  state.signedDecoded = null
  state.currentAddressIndex = Math.max(0, Number(receiveIndex) || 0)
  state.currentAddress = ''
  state.addresses = []
  state.addressError = ''
  state.balance = null
  state.transactions = []
  state.transactionsError = ''
  $('#balanceValue').textContent = '—'
  $('#availableBalance').textContent = '— FRIO'
  $('#balanceCaption').textContent = 'Awaiting wallet connection'
  renderAddresses()
  renderReceive()
  renderTransactions('#recentActivity', [])
  renderTransactions('#fullActivity', [])
}
async function switchSavedWallet(identity) {
  const account = state.accounts.find(item => descriptorIdentity(item.external) === identity)
  if (!account || (state.account && descriptorIdentity(state.account.external) === identity)) return
  state.walletSwitching = true
  renderWalletSelector()
  try {
    if (state.connected) {
      await installAccount(account, false)
      await refreshWallet()
    } else {
      state.account = account
      state.walletName = account.walletName || WALLET
      saveAccount(account)
      clearWalletData(account.receiveIndex)
    }
    toast(`Switched to ${walletDisplayLabel(state.account)}.`)
  } catch (error) {
    toast(`Could not switch wallets: ${error.message}`, true)
  } finally {
    state.walletSwitching = false
    updateAccountState()
  }
}
function showPage(page) {
  state.selectedPage = page
  $$('.content-page').forEach(section => section.classList.toggle('active', section.id === `${page}Page`))
  $$('.nav-item[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page))
  $('#pageLabel').textContent = page[0].toUpperCase() + page.slice(1)
  if (page === 'receive') renderReceive()
  if (page === 'activity') renderTransactions('#fullActivity', state.transactions)
}
function modal(title, html, eyebrow = 'FRIO AIRGAP WALLET') {
  stopCamera()
  stopQr()
  $('#modalBackdrop .modal').classList.remove('airgap-review-modal')
  $('#modalEyebrow').textContent = eyebrow
  $('#modalTitle').textContent = title
  $('#modalContent').innerHTML = html
  $('#modalBackdrop').classList.remove('hidden')
}
function closeModal() {
  stopCamera()
  stopQr()
  $('#modalBackdrop').classList.add('hidden')
}
function showConnectionModal() {
  modal('Connect to your FRIO node', `<p class="modal-copy">This wallet connects only to Friotaíoch Core running on this computer. You can save its credentials encrypted with your operating system's secure storage.</p>
    <form class="modal-form" id="connectionForm">
      <label for="modalRpcUrl">Local RPC address</label><input id="modalRpcUrl" value="${esc(state.rpcUrl)}" autocomplete="off" />
      <label for="modalRpcUser">RPC username</label><input id="modalRpcUser" value="${esc(state.username)}" autocomplete="off" placeholder="From friotaioch.conf" />
      <label for="modalRpcPassword">RPC password</label><input id="modalRpcPassword" type="password" autocomplete="new-password" placeholder="${state.password ? 'Leave blank to use the saved password' : 'From friotaioch.conf'}" />
      <div class="modal-note">Use the FRIO node RPC port <b>51777</b>. This app checks the genesis block before it imports any wallet descriptor.</div>
      <label class="confirm-line auto-connect-option"><input id="modalAutoConnect" type="checkbox" ${state.autoConnect ? 'checked' : ''}><span>Save credentials securely and reconnect automatically next time.</span></label>
      <div id="connectionError"></div><div class="modal-actions"><button type="button" class="button button-quiet" data-close>Cancel</button><button type="submit" class="button button-primary">Connect <span>→</span></button></div>
    </form>`, 'LOCAL NODE')
  $('#connectionForm').addEventListener('submit', async event => {
    event.preventDefault()
    state.rpcUrl = $('#modalRpcUrl').value.trim()
    state.username = $('#modalRpcUser').value.trim()
    state.password = $('#modalRpcPassword').value || state.password
    const submit = event.currentTarget.querySelector('[type="submit"]')
    submit.disabled = true; submit.textContent = 'Connecting…'
    try {
      await connectNode()
      state.autoConnect = $('#modalAutoConnect').checked
      $('#autoConnect').checked = state.autoConnect
      const saved = await persistConnectionSettings()
      closeModal()
      if (saved) toast('Connected to Friotaíoch mainnet.')
      if (!state.account) showPairModal()
    } catch (error) {
      $('#connectionError').innerHTML = `<div class="inline-error">${esc(error.message)}</div>`
      submit.disabled = false; submit.innerHTML = 'Connect <span>→</span>'
    }
  })
  $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
}
async function connectNode() {
  if (!state.username || !state.password) throw new Error('Enter the RPC username and password configured in Friotaíoch Core.')
  state.rpcUrl ||= 'http://127.0.0.1:51777'
  const genesis = await rpc('getblockhash', [0], false)
  if (String(genesis).toLowerCase() !== GENESIS) throw new Error('This node is not Friotaíoch mainnet. No wallet data was imported.')
  const chain = await rpc('getblockchaininfo', [], false)
  if (chain.chain !== 'main') throw new Error('The node is on a non-mainnet chain. Switch it to FRIO mainnet first.')
  state.chain = chain
  connectedUi(true)
  $('#nodeCardTitle').textContent = 'Friotaíoch node connected'
  $('#nodeCardCopy').textContent = 'Connected to your local FRIO mainnet node.'
  $('#blockHeight').textContent = Number(chain.blocks || 0).toLocaleString('en-IE')
  try { await discoverSavedNodeWallets() }
  catch (error) { toast(`Connected, but saved node wallets could not be discovered: ${error.message}`, true) }
  if (state.account) {
    await ensureWatchWallet()
    await installAccount(state.account, false)
    await refreshWallet()
  }
  $('#rpcUrl').value = state.rpcUrl
  $('#rpcUser').value = state.username
  $('#setupBanner').classList.toggle('hidden-banner', !!state.account)
  updateAccountState()
}
async function discoverSavedNodeWallets() {
  const loaded = await rpc('listwallets', [], false)
  const directory = await rpc('listwalletdir', [], false)
  const names = [...new Set([
    ...(Array.isArray(loaded) ? loaded : []),
    ...((directory.wallets || []).map(item => typeof item === 'string' ? item : item.name))
  ])].filter(name => /^FRIO-AirGap-Watch(?:-[a-f0-9]{16})?$/.test(name || ''))
  for (const walletName of names) {
    try {
      if (!loaded.includes(walletName)) await rpc('loadwallet', [walletName], false)
      const info = await rpc('getwalletinfo', [], true, walletName)
      if (info.private_keys_enabled !== false) continue
      const result = await rpc('listdescriptors', [false], true, walletName)
      const descriptors = result.descriptors || []
      const externalDescriptors = descriptors.filter(item => !item.internal && /^wpkh\(/i.test(item.desc || ''))
      // Keep wallet balances attributable: one FRIO node wallet must identify one AirGap account.
      if (externalDescriptors.length !== 1) continue
      const account = await parseAccountDescriptor(externalDescriptors[0].desc)
      if (loadIgnoredAccountIds().includes(descriptorIdentity(account.external))) continue
      const matchingInternal = descriptors.some(item => item.internal && /^wpkh\(/i.test(item.desc || '') && descriptorIdentity(item.desc) === descriptorIdentity(account.internal))
      if (!matchingInternal) continue
      const previous = state.accounts.find(item => descriptorIdentity(item.external) === descriptorIdentity(account.external))
      upsertSavedAccount({ ...account, walletName, receiveIndex: previous?.receiveIndex ?? 0 })
    } catch { /* Skip app-named node wallets that are unavailable or do not contain a supported BIP84 account. */ }
  }
  if (!state.account && state.accounts.length) {
    state.account = state.accounts[0]
    state.walletName = state.account.walletName || WALLET
    saveAccount(state.account)
  }
  renderWalletSelector()
}
async function ensureWatchWallet() {
  const walletName = state.walletName || WALLET
  let loaded = await rpc('listwallets', [], false)
  if (!loaded.includes(walletName)) {
    const directory = await rpc('listwalletdir', [], false)
    const exists = (directory.wallets || []).some(item => item.name === walletName)
    if (exists) await rpc('loadwallet', [walletName], false)
    else await rpc('createwallet', [walletName, true, true, '', false, true], false)
    loaded = await rpc('listwallets', [], false)
  }
  if (!loaded.includes(walletName)) throw new Error('Friotaíoch Core did not load the descriptor-only watch wallet.')
  const info = await rpc('getwalletinfo', [], true, walletName)
  if (info.private_keys_enabled !== false || info.descriptors !== true) {
    throw new Error('This node wallet is not a descriptor-based watch-only wallet. It was not used. Choose another wallet name or inspect the node wallet before pairing.')
  }
}
async function parseAccountDescriptor(value) {
  let descriptor = String(value || '').trim()
  if (!descriptor) throw new Error('Scan the AirGap SegWit account QR or paste its output descriptor.')
  descriptor = descriptor.replace(/^\s*ur:[^\s]+\s*$/i, '')
  const match = descriptor.match(/wpkh\(\[([0-9a-f]{8})\/(84(?:'|h))\/(0(?:'|h))\/(0(?:'|h))\]((?:xpub|zpub)[1-9A-HJ-NP-Za-km-z]+)(?:\/(?:0|1|<0;1>)\/\*)?\)/i)
  if (!match) {
    throw new Error('This QR is not a standard AirGap BIP84 SegWit account descriptor. In AirGap Vault choose Bitcoin SegWit → Sparrow, then scan its account QR. xpub and zpub exports are supported.')
  }
  const [, fingerprint, purpose, coin, account, exportedKey] = match
  if (descriptor.includes('xprv') || descriptor.includes('tprv') || descriptor.includes('zprv')) throw new Error('Private keys are never imported. Export the public account from AirGap Vault.')
  const xpub = await window.frioDesktop.normalizeAccountKey(exportedKey)
  const origin = `${fingerprint.toLowerCase()}/${purpose.replace(/h$/i, "'")}/${coin.replace(/h$/i, "'")}/${account.replace(/h$/i, "'")}`
  return {
    fingerprint: fingerprint.toLowerCase(),
    external: `wpkh([${origin}]${xpub}/0/*)`,
    internal: `wpkh([${origin}]${xpub}/1/*)`
  }
}
function showPairModal() {
  modal('Pair AirGap Vault', `<p class="modal-copy">On your offline AirGap phone, open the Bitcoin <b>SegWit</b> account and choose <b>Sparrow Wallet</b>. Pair each account once; it will be saved on this computer and linked to its FRIO watch-only wallet. Switch saved wallets from the selector in the top bar. Never enter a recovery phrase or private key.</p>
    <div class="camera-frame" id="pairCameraFrame"><video id="pairVideo" muted playsinline></video><div class="camera-hint">Allow camera access, then show the AirGap account QR to your webcam.</div></div>
    <div class="scan-progress"><span id="pairProgress"></span></div><div class="scan-status" id="pairStatus">Camera is off.</div>
    <form class="modal-form" id="pairForm"><label for="accountDescriptor">AirGap public output descriptor</label><textarea id="accountDescriptor" placeholder="wpkh([fingerprint/84'/0'/0']xpub… or zpub…/0/*)"></textarea><div id="pairError"></div><div class="modal-actions"><button type="button" class="button button-quiet" id="startPairCamera">Open camera</button><button type="button" class="button button-quiet" data-close>Cancel</button><button type="submit" class="button button-primary">Add wallet <span>→</span></button></div></form>`, 'WATCH-ONLY ACCOUNT')
  $('#startPairCamera').addEventListener('click', () => startCamera('pair'))
  $('#pairForm').addEventListener('submit', async event => {
    event.preventDefault()
    const form = event.currentTarget
    const submit = form.querySelector('[type="submit"]')
    submit.disabled = true
    submit.textContent = 'Pairing…'
    try {
      const account = await parseAccountDescriptor($('#accountDescriptor').value)
      if (!state.connected) throw new Error('Connect the local FRIO node before pairing the account.')
      await installAccount(account, true)
      closeModal()
      await refreshWallet()
      toast('AirGap wallet saved on this computer.')
      showPage('overview')
    } catch (error) {
      const errorNode = $('#pairError')
      if (errorNode) errorNode.innerHTML = `<div class="inline-error">${esc(error.message)}</div>`
      else toast(error.message, true)
    } finally {
      if (submit?.isConnected) {
        submit.disabled = false
        submit.innerHTML = 'Add wallet <span>→</span>'
      }
    }
  })
  $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
}
function descriptorIdentity(value) {
  return String(value || '').replace(/#[0-9a-z]+$/i, '').replace(/\[([^\]]+)\]/g, (_match, origin) => {
    const canonicalOrigin = origin.replace(/(\d+)h(?=\/|$)/gi, "$1'")
    return `[${canonicalOrigin}]`
  })
}

async function installAccount(account, isNew) {
  if (!state.connected) throw new Error('Connect to the local FRIO node first.')
  const previousWallet = state.walletName
  const previousAccount = state.account
  const accountChanged = !previousAccount || descriptorIdentity(previousAccount.external) !== descriptorIdentity(account.external)
  if (previousAccount) rememberAccountWallet(previousAccount, previousWallet || previousAccount.walletName || WALLET)
  try {
    const selectedWallet = await walletNameForAccount(account)
    state.walletName = selectedWallet
    await ensureWatchWallet()
    const walletInfo = await rpc('getwalletinfo', [], true)
    if (walletInfo.private_keys_enabled !== false) throw new Error('The node wallet is not descriptor-only. Create the watch-only wallet with private keys disabled.')
    const existing = await rpc('listdescriptors', [false], true)
    const wantedDescriptors = [
      { desc: account.external, internal: false },
      { desc: account.internal, internal: true }
    ]
    const requests = []
    for (const wanted of wantedDescriptors) {
      const info = await rpc('getdescriptorinfo', [wanted.desc], false)
      const identity = descriptorIdentity(info.descriptor)
      const previous = (existing.descriptors || []).find(item => item.internal === wanted.internal && descriptorIdentity(item.desc) === identity)
      const oldRange = Array.isArray(previous?.range) ? previous.range.map(Number) : [0, -1]
      const range = [Math.min(0, oldRange[0]), Math.max(999, oldRange[1])]
      const alreadyReady = previous?.active && range[0] === 0 && range[1] >= 999
      if (!alreadyReady) requests.push({ desc: info.descriptor, timestamp: 0, active: true, internal: wanted.internal, range })
    }
    if (requests.length) {
      const result = await rpc('importdescriptors', [requests], true)
      const failure = (result || []).find(item => !item.success)
      if (failure) throw new Error(failure.error?.message || 'The FRIO node could not import the public account descriptor.')
    }
    if (accountChanged) state.currentAddressIndex = Math.max(0, Number(account.receiveIndex) || 0)
    saveAccount({ ...account, walletName: selectedWallet, receiveIndex: state.currentAddressIndex })
    if (accountChanged) clearWalletData(state.currentAddressIndex)
    updateAccountState()
    $('#accountBadge').textContent = 'Paired'
    $('#setupBanner').classList.toggle('hidden-banner', state.connected)
  } catch (error) {
    state.walletName = previousWallet || WALLET
    state.account = previousAccount
    throw error
  }
}

async function activeReceiveRange(info) {
  const descriptorInfo = info || await rpc('getdescriptorinfo', [state.account.external], false)
  const identity = descriptorIdentity(descriptorInfo.descriptor)
  const walletDescriptors = await rpc('listdescriptors', [false], true)
  return (walletDescriptors.descriptors || []).find(item => !item.internal && descriptorIdentity(item.desc) === identity)
}

async function readWalletBalance() {
  const failures = []
  let structuredBalance = null
  let legacyBalance = null
  try {
    const balances = await rpc('getbalances', [], true)
    const trustedBalances = [balances?.mine?.trusted, balances?.watchonly?.trusted]
      .filter(value => value !== undefined && value !== null && Number.isFinite(Number(value)))
      .map(Number)
    if (trustedBalances.length) structuredBalance = trustedBalances.reduce((total, value) => total + value, 0)
    else failures.push('Core returned no trusted balance fields.')
  } catch (error) {
    failures.push(error.message)
  }

  try {
    // Older FRIO Core builds may not expose getbalances; also cross-check its legacy watch-only aggregate.
    const value = Number(await rpc('getbalance', ['*', 0, true], true))
    if (Number.isFinite(value) && value >= 0) legacyBalance = value
    else failures.push('Core returned an invalid legacy wallet balance.')
  } catch (error) {
    failures.push(error.message)
  }
  const available = [structuredBalance, legacyBalance].filter(value => value !== null)
  if (available.length) return Math.max(...available)
  throw new Error(failures.join(' '))
}

async function ensureReceiveIndexImported(index) {
  const info = await rpc('getdescriptorinfo', [state.account.external], false)
  const identity = descriptorIdentity(info.descriptor)
  const walletDescriptors = await rpc('listdescriptors', [false], true)
  const previous = (walletDescriptors.descriptors || []).find(item => !item.internal && descriptorIdentity(item.desc) === identity)
  const oldRange = Array.isArray(previous?.range) ? previous.range.map(Number) : [0, 999]
  if (oldRange[1] >= index && previous?.active) return oldRange[1]
  const rangeEnd = Math.max(999, oldRange[1] + 1000, index)
  const result = await rpc('importdescriptors', [[{
    desc: info.descriptor, timestamp: 0, active: true, internal: false,
    range: [Math.min(0, oldRange[0]), rangeEnd]
  }]], true)
  if (!result?.[0]?.success) throw new Error(result?.[0]?.error?.message || 'The FRIO node could not extend the receive address range.')
  return rangeEnd
}

async function loadReceiveAddresses(minimumEnd = 29) {
  // deriveaddresses is more portable across Bitcoin Core forks with the canonical checksum attached.
  const info = await rpc('getdescriptorinfo', [state.account.external], false)
  const descriptor = await activeReceiveRange(info)
  const walletEnd = Array.isArray(descriptor?.range) ? Number(descriptor.range[1]) : 999
  const rangeEnd = Math.max(minimumEnd, Number.isFinite(walletEnd) ? walletEnd : 999)
  const derived = await rpc('deriveaddresses', [info.descriptor, [0, rangeEnd]], false)
  if (!Array.isArray(derived) || !derived.length) throw new Error('The node returned no addresses for the paired BIP84 descriptor.')
  if (!derived[0].startsWith('frio1q')) throw new Error('The node did not derive a FRIO native SegWit address for BIP84 index #0.')
  state.addresses = derived.map((address, index) => ({ address, index }))
  if (!state.addresses.length || !state.addresses.some(item => item.index === state.currentAddressIndex)) state.currentAddressIndex = 0
  const current = state.addresses.find(item => item.index === state.currentAddressIndex) || state.addresses[0]
  state.currentAddressIndex = current?.index ?? 0
  state.currentAddress = current?.address || ''
  state.addressError = ''
}

async function refreshWallet() {
  if (!state.connected) return
  try {
    const chain = await rpc('getblockchaininfo', [], false)
    if (String(await rpc('getblockhash', [0], false)).toLowerCase() !== GENESIS) throw new Error('Connected node changed; verify it is Friotaíoch mainnet.')
    state.chain = chain
    $('#blockHeight').textContent = Number(chain.blocks || 0).toLocaleString('en-IE')
    if (!state.account) return
    await ensureWatchWallet()
    const info = await rpc('getwalletinfo', [], true)
    if (info.private_keys_enabled !== false) throw new Error('The selected node wallet has private keys enabled. This app requires its dedicated watch-only wallet.')
    const errors = []
    let balanceLoaded = false
    try {
      state.balance = await readWalletBalance()
      balanceLoaded = true
      $('#balanceValue').textContent = formatFrio(state.balance, 8)
      $('#availableBalance').textContent = `${formatFrio(state.balance, 8)} FRIO`
    } catch (error) {
      errors.push(`Balance: ${error.message}`)
    }
    try {
      state.transactions = newestTransactionsFirst(await rpc('listtransactions', ['*', 30, 0, true], true))
      state.transactionsError = ''
    } catch (error) {
      state.transactions = []
      state.transactionsError = error.message
      errors.push(`Activity: ${error.message}`)
    }
    $('#balanceCaption').textContent = !balanceLoaded ? 'Balance unavailable' : info.scanning ? `Wallet scan ${Math.floor((info.scanning.progress || 0) * 100)}%` : 'FRIO available in this account'
    $('#nodeCardTitle').textContent = info.scanning ? 'Scanning wallet history' : 'Friotaíoch node connected'
    $('#nodeCardCopy').textContent = info.scanning ? 'The node is checking this account from its first block.' : 'Your watch-only account is synced with FRIO mainnet.'
    $('#setupBanner').classList.toggle('hidden-banner', !!state.account)
    renderTransactions('#recentActivity', state.transactions.slice(0, 6))
    if (state.selectedPage === 'activity') renderTransactions('#fullActivity', state.transactions)
    try {
      await loadReceiveAddresses()
    } catch (error) {
      state.addressError = error.message
      errors.push(`Receive address #0: ${error.message}`)
    }
    renderAddresses()
    if (state.selectedPage === 'receive') renderReceive()
    updateAccountState()
    if (errors.length) toast(errors.join(' · '), true)
  } catch (error) {
    toast(error.message, true)
  }
}
function renderTransactions(target, txs) {
  const container = $(target)
  if (!container) return
  if (!state.account || !state.connected || !txs?.length) {
    const title = !state.account || !state.connected ? 'Wallet not connected' : state.transactionsError ? 'Activity unavailable' : 'No activity yet'
    const detail = !state.account || !state.connected ? 'Connect your FRIO node and pair an account to see transactions.' : state.transactionsError || 'Incoming and outgoing FRIO transfers will appear here.'
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">↕</span><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>`
    return
  }
  const rows = txs.map(tx => {
    const sent = Number(tx.amount) < 0
    const pending = Number(tx.confirmations || 0) <= 0
    const detail = sent ? (tx.address || 'Transfer sent') : (tx.address || 'FRIO received')
    const amount = Math.abs(Number(tx.amount || 0))
    const date = tx.time ? new Date(tx.time * 1000).toLocaleDateString('en-IE', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Pending'
    const index = txs.indexOf(tx)
    return `<tr class="activity-row" data-activity-index="${index}" tabindex="0" role="button" aria-label="Open ${sent ? 'sent' : 'received'} transfer details"><td><div class="tx-type"><span class="tx-avatar ${sent ? 'sent' : ''}">${sent ? '↑' : '↓'}</span><span>${sent ? 'Sent FRIO' : 'Received FRIO'}</span></div></td><td><span class="tx-state ${pending ? 'pending' : ''}"><i></i>${pending ? 'Unconfirmed' : `${Number(tx.confirmations)} confirmations`}</span></td><td>${esc(shorten(detail, 24))}</td><td>${esc(date)}</td><td class="tx-amount ${sent ? 'negative' : 'positive'}">${sent ? '−' : '+'}${formatFrio(amount)} FRIO</td></tr>`
  }).join('')
  container.innerHTML = `<table class="tx-list"><thead><tr><th>TYPE</th><th>STATUS</th><th>ADDRESS</th><th>DATE</th><th>AMOUNT</th></tr></thead><tbody>${rows}</tbody></table>`
  container.querySelectorAll('[data-activity-index]').forEach(row => {
    const open = () => showActivityDetails(txs[Number(row.dataset.activityIndex)])
    row.addEventListener('click', open)
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } })
  })
}
function transactionTimestamp(tx) {
  for (const value of [tx?.time, tx?.timereceived, tx?.blocktime]) {
    const timestamp = Number(value)
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp
  }
  return 0
}
function newestTransactionsFirst(transactions) {
  return [...(Array.isArray(transactions) ? transactions : [])]
    .sort((a, b) => transactionTimestamp(b) - transactionTimestamp(a))
}
function activityAddressMarkup(address, label, allowSend = true) {
  const value = String(address || '')
  const frioAddress = decodeSegwitAddress(value, 'frio') ? value.toLowerCase() : bitcoinToFrioAddress(value)
  const comparison = frioAddress ? addressComparisonHtml(frioAddress) : `<div class="activity-address-raw"><code>${esc(value)}</code></div>`
  const btcAddress = frioAddress ? bitcoinEquivalentAddress(frioAddress) : ''
  const target = allowSend && frioAddress ? `data-activity-send="${esc(frioAddress)}" tabindex="0" role="button" aria-label="Send to ${esc(frioAddress)}"` : ''
  return `<div class="activity-address"><div class="activity-address-title">${esc(label)}</div><div class="activity-address-target" ${target}>${comparison}</div><div class="activity-address-actions"><button class="button button-quiet" data-activity-copy="${esc(frioAddress || value)}">Copy ${frioAddress ? 'FRIO' : 'address'}</button>${btcAddress ? `<button class="button button-quiet" data-activity-copy="${esc(btcAddress)}">Copy BTC</button>` : ''}${allowSend && frioAddress ? `<button class="button button-secondary" data-activity-send="${esc(frioAddress)}" data-send-button>Send to this address</button>` : ''}</div></div>`
}
function transactionInputs(decoded) {
  return decoded?.vin || decoded?.tx?.vin || []
}
function addressFromScriptPubKey(scriptPubKey) {
  return scriptPubKey?.address || scriptPubKey?.addresses?.[0] || ''
}
async function sourceAddressesForTransaction(detail, decoded) {
  const vin = transactionInputs(decoded)
  const known = new Set()
  for (const input of vin) {
    const address = addressFromScriptPubKey(input.prevout?.scriptPubKey)
    if (address) known.add(address)
  }
  if (!vin.length) return [...known]
  let unresolved = vin.filter(input => !addressFromScriptPubKey(input.prevout?.scriptPubKey))
  if (!unresolved.length) return [...known]
  if (detail?.blockhash) {
    try {
      const block = await rpc('getblock', [detail.blockhash, 3], false)
      const transaction = (block?.tx || []).find(item => String(item.txid || '').toLowerCase() === String(detail.txid || '').toLowerCase())
      const blockInputs = transaction?.vin || []
      for (const input of blockInputs) {
        const address = addressFromScriptPubKey(input.prevout?.scriptPubKey)
        if (address) known.add(address)
      }
      if (blockInputs.length) unresolved = blockInputs.filter(input => !addressFromScriptPubKey(input.prevout?.scriptPubKey))
    } catch { /* Older nodes may not support getblock verbosity 3 or have block undo data. */ }
  }
  const lookups = unresolved.filter(input => input.txid && Number.isInteger(Number(input.vout))).slice(0, 10)
  const resolved = await Promise.all(lookups.map(async input => {
    try {
      const previous = await rpc('getrawtransaction', [input.txid, true], false)
      const address = addressFromScriptPubKey(previous?.vout?.[Number(input.vout)]?.scriptPubKey)
      return address || ''
    } catch { return '' }
  }))
  return [...new Set(resolved.filter(Boolean))]
}
function attachActivityActions(txid, root = $('#modalContent'), includeExplorer = true) {
  root.querySelectorAll('[data-activity-copy]').forEach(button => button.addEventListener('click', () => copyText(button.dataset.activityCopy)))
  root.querySelectorAll('[data-activity-send]').forEach(element => {
    element.addEventListener('click', () => fillRecipientAndOpenSend(element.dataset.activitySend))
    if (element.matches('[tabindex]')) element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fillRecipientAndOpenSend(element.dataset.activitySend) } })
  })
  const explorerButton = includeExplorer ? root.querySelector('[data-open-transaction]') : null
  if (explorerButton && /^[0-9a-f]{64}$/i.test(txid || '')) explorerButton.addEventListener('click', () => window.frioDesktop.openExternal(`https://explorer.friotaioch.com/tx/${txid}`))
  else if (explorerButton) explorerButton.disabled = true
}
function fillRecipientAndOpenSend(address) {
  const frioAddress = decodeSegwitAddress(address, 'frio') ? address.toLowerCase() : bitcoinToFrioAddress(address)
  $('#recipient').value = frioAddress || address
  $('#recipient').dispatchEvent(new Event('input', { bubbles: true }))
  closeModal()
  showPage('send')
}
async function showActivityDetails(tx) {
  if (!tx) return
  const requestId = ++state.activityRequestId
  const txid = tx.txid || tx.hash || ''
  const sent = tx.category === 'send' || Number(tx.amount) < 0
  const received = tx.category === 'receive' || (!sent && !['generate', 'immature', 'orphan'].includes(tx.category) && Number(tx.amount) > 0)
  const title = sent ? 'Sent FRIO' : received ? 'Received FRIO' : 'Transaction details'
  const when = transactionTimestamp(tx) ? new Date(transactionTimestamp(tx) * 1000).toLocaleString('en-IE') : 'Date unavailable'
  const amount = `${sent ? '−' : '+'}${formatFrio(Math.abs(Number(tx.amount || 0)))} FRIO`
  const fee = Number.isFinite(Number(tx.fee)) ? formatFrio(Math.abs(Number(tx.fee))) : 'Not reported'
  const initialAddresses = sent && tx.address ? activityAddressMarkup(tx.address, 'Sent to') : received && tx.address ? activityAddressMarkup(tx.address, 'Received at', false) : ''
  modal(title, `<div class="review-box"><div class="review-row"><span>Amount</span><strong>${esc(amount)}</strong></div><div class="review-row"><span>Status</span><strong>${Number(tx.confirmations || 0) > 0 ? `${Number(tx.confirmations)} confirmations` : 'Unconfirmed'}</strong></div><div class="review-row"><span>Date</span><strong>${esc(when)}</strong></div><div class="review-row"><span>Network fee</span><strong>${fee} FRIO</strong></div></div>${initialAddresses}<div id="activityCounterparty"><p class="modal-copy">Loading transaction addresses…</p></div><div class="activity-address-actions"><button class="button button-secondary" data-open-transaction>Open in FRIO explorer ↗</button></div><div class="modal-actions"><button class="button button-primary" data-close>Done</button></div>`, 'RECENT ACTIVITY')
  $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
  attachActivityActions(txid)
  if (!txid || !state.connected) { $('#activityCounterparty').innerHTML = '<p class="modal-copy">Transaction address details are unavailable while disconnected.</p>'; return }
  try {
    let detail
    try { detail = await rpc('gettransaction', [txid, true, true], true) }
    catch { detail = await rpc('gettransaction', [txid, true], true) }
    let decoded = detail?.decoded || detail?.tx || detail
    if (!transactionInputs(decoded).length && detail?.hex) {
      try { decoded = await rpc('decoderawtransaction', [detail.hex], false) } catch { /* The block or explorer may still provide input context. */ }
    }
    const sourceAddresses = received ? await sourceAddressesForTransaction({ ...detail, txid }, decoded) : []
    if (requestId !== state.activityRequestId || $('#modalBackdrop').classList.contains('hidden')) return
    const displayLimit = 10
    const sourceMarkup = sourceAddresses.slice(0, displayLimit).map((address, index) => activityAddressMarkup(address, sourceAddresses.length > 1 ? `Sent from · input source ${index + 1}` : 'Sent from', true)).join('')
    const more = sourceAddresses.length > displayLimit ? `<p class="modal-copy">${sourceAddresses.length - displayLimit} additional input source addresses are not shown.</p>` : ''
    let fallback = ''
    if (received && !sourceAddresses.length) fallback = '<p class="modal-copy">The node could not resolve the source input address for this transaction. Open it in the explorer to inspect its inputs.</p>'
    if (sent && !tx.address) {
      const sentTo = (detail?.details || []).find(item => item.category === 'send' && item.address)?.address
      if (sentTo) $('#activityCounterparty').innerHTML = activityAddressMarkup(sentTo, 'Sent to')
      else $('#activityCounterparty').innerHTML = '<p class="modal-copy">The node did not report a recipient address for this transaction.</p>'
    } else if (received) {
      $('#activityCounterparty').innerHTML = `${sourceMarkup}${more}${fallback}`
    } else $('#activityCounterparty').innerHTML = ''
    attachActivityActions(txid, $('#activityCounterparty'), false)
  } catch (error) {
    if (requestId === state.activityRequestId) $('#activityCounterparty').innerHTML = `<p class="modal-copy">Could not load transaction address details: ${esc(error.message)}</p>`
  }
}
function shorten(text, length = 28) {
  const value = String(text || '')
  return value.length > length ? `${value.slice(0, 10)}…${value.slice(-8)}` : value
}
function renderAddresses() {
  $('#addressCount').textContent = String(state.addresses.length)
  if (!state.addresses.length) {
    const message = state.addressError
      ? `Could not derive receive addresses: ${state.addressError}`
      : !state.account ? 'Pair an account to derive receive address #0'
        : !state.connected ? 'Connect the node to derive receive address #0'
          : 'Deriving receive address #0…'
    $('#addressList').innerHTML = `<div class="empty-inline">${esc(message)}</div>`
    $('#currentAddress').textContent = message
    $('#currentAddressLabel').textContent = 'RECEIVE ADDRESS · INDEX #0'
    $('#receiveIndexLabel').textContent = 'BIP84 receive index #0'
    return
  }
  $('#currentAddress').innerHTML = state.currentAddress ? addressComparisonHtml(state.currentAddress) : 'Receive address #0 is ready'
  const addressLabel = `RECEIVE ADDRESS · INDEX #${state.currentAddressIndex}`
  $('#currentAddressLabel').textContent = addressLabel
  $('#receiveIndexLabel').textContent = `BIP84 receive index #${state.currentAddressIndex}`
  $('#addressList').innerHTML = state.addresses.map(({ address, index }) => `<div class="address-row ${index === state.currentAddressIndex ? 'active-address' : ''}"><span class="address-index">#${String(index).padStart(4, '0')}</span><div class="address-row-content">${addressComparisonHtml(address)}<small>Receive · BIP84 index ${index}</small></div><button class="copy-button" data-copy="${esc(address)}" aria-label="Copy FRIO receive address ${index}">▢</button></div>`).join('')
  $('#addressList').querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', () => copyText(button.dataset.copy)))
}
async function getReceiveAddress() {
  if (!state.connected || !state.account) { toast('Connect the node and pair an AirGap account first.', true); return }
  try {
    const nextIndex = state.currentAddressIndex + 1
    const rangeEnd = await ensureReceiveIndexImported(nextIndex)
    if (!state.addresses.some(item => item.index === nextIndex)) await loadReceiveAddresses(rangeEnd)
    const address = state.addresses.find(item => item.index === nextIndex)?.address
    if (!address) throw new Error(`Could not derive FRIO receive address #${nextIndex}.`)
    if (!address.startsWith('frio1q')) throw new Error('The node did not return a standard FRIO SegWit v0 address.')
    state.currentAddressIndex = nextIndex
    saveAccount({ ...state.account, receiveIndex: nextIndex })
    state.currentAddress = address
    renderAddresses()
    renderReceive()
    toast(`Showing deterministic FRIO receive address #${nextIndex}.`)
  } catch (error) { toast(error.message, true) }
}
function renderReceive() {
  const address = state.currentAddress || ''
  $('#receiveAddressText').innerHTML = address ? addressComparisonHtml(address) : '—'
  $('#receiveIndexLabel').textContent = `BIP84 receive index #${state.currentAddressIndex}`
  const holder = $('#receiveQr')
  if (!address) {
    const message = state.addressError
      ? `Could not derive receive address #0: ${state.addressError}`
      : !state.account ? 'Pair an account to derive receive address #0'
        : !state.connected ? 'Connect the node to derive receive address #0'
          : 'Deriving receive address #0…'
    holder.innerHTML = `<span>${esc(message)}</span>`
    return
  }
  window.frioDesktop.addressQr(address)
    .then(dataUrl => { holder.innerHTML = `<img alt="QR code for ${esc(address)}" src="${dataUrl}">` })
    .catch(() => { holder.textContent = 'Could not create the address QR.' })
}
async function copyText(value) {
  try {
    await window.frioDesktop.copyText(value)
    toast('Copied to clipboard.')
  } catch {
    try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.') }
    catch { toast('Clipboard is unavailable. The report is shown in a selectable text box.', true) }
  }
}
function scriptType(script) {
  const hex = String(script || '').replace(/^0x/i, '').toLowerCase()
  if (/^0014[0-9a-f]{40}$/.test(hex)) return 'P2WPKH'
  if (/^0020[0-9a-f]{64}$/.test(hex)) return 'P2WSH'
  if (/^5120[0-9a-f]{64}$/.test(hex)) return 'P2TR'
  if (/^76a914[0-9a-f]{40}88ac$/.test(hex)) return 'P2PKH'
  if (/^a914[0-9a-f]{40}87$/.test(hex)) return 'P2SH'
  return hex ? 'other script' : 'not exposed by decodepsbt'
}
function derivationPathClass(path) {
  const normalized = String(path || '').trim().replace(/[hH](?=\/|$)/g, "'").replace(/^m\//i, '')
  const match = normalized.match(/^84'\/0'\/0'\/([01])\/(\d+)$/)
  return match ? (match[1] === '0' ? 'external' : 'change') : ''
}
function countMapFields(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}
function inputUtxoScript(input) {
  return input?.witness_utxo?.scriptPubKey?.hex || input?.witness_utxo?.scriptPubKey ||
    input?.witness_utxo?.script || input?.witness_utxo?.script_pub_key?.hex || ''
}
function airGapCompatibilityReport() {
  const prepared = state.unsignedPsbt
  if (!prepared) throw new Error('Prepare a transfer before creating its compatibility report.')
  const decoded = prepared.decoded || {}
  const inputs = Array.isArray(decoded.inputs) ? decoded.inputs : []
  const outputs = Array.isArray(decoded.outputs) ? decoded.outputs : []
  const fingerprint = String(state.account?.fingerprint || '').toLowerCase()
  const lines = [
    'Friotaíoch AirGap Wallet 0.3.12 · AirGap PSBT compatibility report',
    'Privacy: raw PSBT, addresses, amounts, txids, public keys, full fingerprint, and credentials are omitted.',
    `PSBT: v${decoded.psbt_version ?? 0}; encoded bytes=${Math.floor(prepared.psbt.length * 3 / 4)}; format=${prepared.psbt.startsWith('cHNidP8') ? 'base64 PSBT magic present' : 'unexpected encoding'}`,
    `Transaction: version=${decoded.tx?.version ?? 'unavailable'}; locktime=${decoded.tx?.locktime ?? 'unavailable'}; inputs=${inputs.length}; outputs=${outputs.length}`,
    `Paired account: ${fingerprint ? 'fingerprint available for comparison' : 'fingerprint unavailable'}; expected path family=BIP84 m/84'/0'/0'`
  ]
  inputs.forEach((input, index) => {
    const derivations = Array.isArray(input.bip32_derivs) ? input.bip32_derivs : []
    const matching = derivations.filter(item => String(item.master_fingerprint || '').replace(/^0x/i, '').toLowerCase() === fingerprint)
    const branches = matching.map(item => derivationPathClass(item.path)).filter(Boolean)
    const hasWitness = !!input.witness_utxo
    const hasNonWitness = !!input.non_witness_utxo
    lines.push(`Input #${index}: witness_utxo=${hasWitness ? 'yes' : 'no'}; non_witness_utxo=${hasNonWitness ? 'yes' : 'no'}; utxo_script=${scriptType(inputUtxoScript(input))}; bip32_derivations=${derivations.length}; paired_fingerprint_derivations=${matching.length}; matching_BIP84_paths=${branches.length} (external=${branches.filter(branch => branch === 'external').length}, change=${branches.filter(branch => branch === 'change').length}); partial_signatures=${countMapFields(input.partial_signatures)}; sighash=${input.sighash ?? 'unspecified'}; unknown_fields=${countMapFields(input.unknown)}; proprietary_fields=${countMapFields(input.proprietary)}`)
  })
  const transactionOutputs = Array.isArray(prepared.outputs) ? prepared.outputs : []
  transactionOutputs.forEach((output, index) => {
    const details = outputs[index] || {}
    lines.push(`Output #${index} (${output.address === prepared.recipient ? 'recipient' : 'change/other'}): script=${scriptType(output.script)}; bip32_derivations=${Array.isArray(details.bip32_derivs) ? details.bip32_derivs.length : 0}; unknown_fields=${countMapFields(details.unknown)}; proprietary_fields=${countMapFields(details.proprietary)}`)
  })
  if (!inputs.length) lines.push('Input metadata: decodepsbt did not expose per-input maps.')
  return lines.join('\n')
}
function diagnosticTextarea(report, id = 'psbtDiagnosticText') {
  return `<textarea id="${id}" readonly aria-label="AirGap PSBT compatibility report" style="width:100%;height:190px;margin-top:8px;padding:10px;resize:vertical;background:#0c1216;color:#cbd5cf;border:1px solid #2b373f;border-radius:7px;font:9px/1.5 ui-monospace,Consolas,monospace;user-select:text">${esc(report)}</textarea>`
}
function inputDerivationReadiness() {
  const inputs = Array.isArray(state.unsignedPsbt?.decoded?.inputs) ? state.unsignedPsbt.decoded.inputs : []
  const fingerprint = String(state.account?.fingerprint || '').toLowerCase()
  const matched = inputs.filter(input => (Array.isArray(input.bip32_derivs) ? input.bip32_derivs : []).some(item =>
    String(item.master_fingerprint || '').replace(/^0x/i, '').toLowerCase() === fingerprint && derivationPathClass(item.path)))
  return { count: inputs.length, matched: matched.length }
}
function isValidAmount(value) {
  return /^\d+(?:\.\d{1,8})?$/.test(value.trim()) && Number(value) > 0
}
function isValidFeeRate(value) {
  const rate = Number(value)
  return /^\d+(?:\.\d{1,3})?$/.test(value.trim()) && Number.isFinite(rate) && rate >= 0.1 && rate <= 1000
}
function amountToSatoshis(value) {
  const [whole, fraction = ''] = String(value).split('.')
  return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))
}
function decodedOutputDetails(output, index) {
  const scriptPubKey = output?.scriptPubKey ?? output?.script ?? {}
  const script = typeof scriptPubKey === 'string' ? scriptPubKey : (scriptPubKey?.hex || '')
  const addresses = [
    scriptPubKey?.address,
    ...(Array.isArray(scriptPubKey?.addresses) ? scriptPubKey.addresses : []),
    output?.address
  ].filter(value => typeof value === 'string' && value.length)
  return {
    index,
    address: addresses[0] || 'FRIO output',
    addresses,
    amount: Number(output?.value ?? output?.amount ?? 0),
    script: String(script).replace(/^0x/i, '').toLowerCase()
  }
}
function psbtReader(bytes) {
  let offset = 0
  function readBytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) throw new Error('The PSBT is truncated or malformed.')
    const result = bytes.subarray(offset, offset + length)
    offset += length
    return result
  }
  function readCompactSize() {
    const marker = readBytes(1)[0]
    let value
    if (marker < 0xfd) value = BigInt(marker)
    else {
      const size = marker === 0xfd ? 2 : marker === 0xfe ? 4 : 8
      const encoded = readBytes(size)
      value = 0n
      for (let i = size - 1; i >= 0; i--) value = (value << 8n) | BigInt(encoded[i])
      if ((marker === 0xfd && value < 0xfdn) || (marker === 0xfe && value <= 0xffffn) || (marker === 0xff && value <= 0xffffffffn)) throw new Error('The PSBT contains a non-canonical length.')
    }
    if (value > 2_000_000n) throw new Error('The PSBT contains an unsupported field length.')
    return Number(value)
  }
  return { readBytes, readCompactSize, get offset() { return offset }, get length() { return bytes.length } }
}
function readPsbtMap(reader) {
  const entries = []
  const seenKeys = new Set()
  while (true) {
    const keyLength = reader.readCompactSize()
    if (keyLength === 0) return entries
    const key = reader.readBytes(keyLength)
    const keyHex = bytesToHex(key)
    if (seenKeys.has(keyHex)) throw new Error('The PSBT contains a duplicate map key.')
    seenKeys.add(keyHex)
    const value = reader.readBytes(reader.readCompactSize())
    entries.push({ type: key[0], keyData: key.subarray(1), value })
    if (entries.length > 100_000) throw new Error('The PSBT contains too many map entries.')
  }
}
function compactSizeBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('The PSBT field is too large to encode.')
  if (value < 0xfd) return Uint8Array.of(value)
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >>> 8)
  return Uint8Array.of(0xfe, value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
}
function concatenateBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
  return result
}
function serializePsbtMap(entries) {
  const chunks = []
  for (const entry of entries) {
    const key = new Uint8Array(entry.keyData.length + 1)
    key[0] = entry.type
    key.set(entry.keyData, 1)
    chunks.push(compactSizeBytes(key.length), key, compactSizeBytes(entry.value.length), entry.value)
  }
  chunks.push(Uint8Array.of(0))
  return concatenateBytes(chunks)
}
function base64FromBytes(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
function psbtBytesFromBase64(value, maximumLength = 2_000_000) {
  if (typeof value !== 'string' || value.length < 8 || value.length > maximumLength || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('The PSBT payload is invalid or too large to inspect.')
  }
  let binary
  try { binary = atob(value) } catch { throw new Error('The PSBT payload is not valid base64.') }
  if (btoa(binary) !== value || !binary.startsWith('psbt\xff')) throw new Error('The payload is not a valid canonical PSBT.')
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
function addExplicitSighashAll(psbtBase64) {
  const bytes = psbtBytesFromBase64(psbtBase64)
  const reader = psbtReader(bytes)
  if (bytesToHex(reader.readBytes(5)) !== '70736274ff') throw new Error('The node returned data that is not a valid PSBT.')
  const globalMap = readPsbtMap(reader)
  const unsignedTransaction = psbtMapValue(globalMap, 0x00)
  if (!unsignedTransaction) throw new Error('A PSBT without a v0 unsigned transaction cannot be normalized for AirGap.')
  const transaction = parseUnsignedTransaction(unsignedTransaction)
  const inputMaps = Array.from({ length: transaction.vin.length }, () => readPsbtMap(reader))
  const outputMaps = Array.from({ length: transaction.vout.length }, () => readPsbtMap(reader))
  if (reader.offset !== reader.length) throw new Error('The PSBT contains trailing map data.')
  const allSighash = Uint8Array.of(1, 0, 0, 0)
  const normalizedInputs = inputMaps.map(map => {
    const existing = map.filter(entry => entry.type === 0x03)
    if (existing.length) {
      if (existing.length !== 1 || existing[0].keyData.length !== 0 ||
          existing[0].value.length !== allSighash.length ||
          existing[0].value.some((byte, index) => byte !== allSighash[index])) {
        throw new Error('The node prepared an input with an invalid or non-ALL sighash setting. The wallet will not create a signing QR for it.')
      }
      return map
    }
    return [...map, { type: 0x03, keyData: new Uint8Array(0), value: allSighash }]
  })
  const normalized = concatenateBytes([
    bytes.subarray(0, 5), serializePsbtMap(globalMap),
    ...normalizedInputs.map(serializePsbtMap), ...outputMaps.map(serializePsbtMap)
  ])
  return base64FromBytes(normalized)
}
function psbtMapValue(map, type) {
  return map.find(entry => entry.type === type && entry.keyData.length === 0)?.value
}
function readLittleEndian(bytes, signed = false) {
  if (![2, 4, 8].includes(bytes.length)) throw new Error('The PSBT contains a malformed integer.')
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i])
  if (signed && (value & (1n << BigInt(bytes.length * 8 - 1)))) value -= 1n << BigInt(bytes.length * 8)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('The PSBT integer is outside the supported range.')
  return Number(value)
}
function readCompactSizeValue(bytes) {
  const reader = psbtReader(bytes)
  const value = reader.readCompactSize()
  if (reader.offset !== bytes.length) throw new Error('The PSBT contains a malformed count.')
  return value
}
function bytesToHex(bytes, reverse = false) {
  const data = reverse ? [...bytes].reverse() : bytes
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('')
}
function parseUnsignedTransaction(bytes) {
  const reader = psbtReader(bytes)
  const version = readLittleEndian(reader.readBytes(4), true)
  const inputCount = reader.readCompactSize()
  if (!inputCount || inputCount > 100_000) throw new Error('The PSBT unsigned transaction has an invalid input count.')
  const vin = []
  for (let i = 0; i < inputCount; i++) {
    const txid = bytesToHex(reader.readBytes(32), true)
    const vout = readLittleEndian(reader.readBytes(4))
    reader.readBytes(reader.readCompactSize()) // scriptSig (empty in an unsigned PSBT transaction)
    const sequence = readLittleEndian(reader.readBytes(4))
    vin.push({ txid, vout, sequence })
  }
  const outputCount = reader.readCompactSize()
  if (!outputCount || outputCount > 100_000) throw new Error('The PSBT unsigned transaction has an invalid output count.')
  const vout = []
  for (let i = 0; i < outputCount; i++) {
    const satoshis = readLittleEndian(reader.readBytes(8))
    const script = bytesToHex(reader.readBytes(reader.readCompactSize()))
    if (satoshis < 0) throw new Error('The PSBT contains a negative output amount.')
    vout.push({ value: satoshis / 100_000_000, scriptPubKey: { hex: script } })
  }
  const locktime = readLittleEndian(reader.readBytes(4))
  if (reader.offset !== bytes.length) throw new Error('The PSBT unsigned transaction has trailing data.')
  return { version, locktime, vin, vout }
}
function parsePsbtV2Transaction(reader, globalMap) {
  const versionBytes = psbtMapValue(globalMap, 0x02)
  const fallbackLocktimeBytes = psbtMapValue(globalMap, 0x03)
  const inputCountBytes = psbtMapValue(globalMap, 0x04)
  const outputCountBytes = psbtMapValue(globalMap, 0x05)
  if (!versionBytes || versionBytes.length !== 4 || !inputCountBytes || !outputCountBytes) throw new Error('The PSBT v2 transaction fields are incomplete.')
  const inputCount = readCompactSizeValue(inputCountBytes)
  const outputCount = readCompactSizeValue(outputCountBytes)
  if (!inputCount || !outputCount || inputCount > 100_000 || outputCount > 100_000) throw new Error('The PSBT v2 transaction has invalid input or output counts.')
  const inputMaps = Array.from({ length: inputCount }, () => readPsbtMap(reader))
  const outputMaps = Array.from({ length: outputCount }, () => readPsbtMap(reader))
  const vin = inputMaps.map(map => {
    const txid = psbtMapValue(map, 0x0e)
    const outputIndex = psbtMapValue(map, 0x0f)
    const sequenceBytes = psbtMapValue(map, 0x10)
    if (!txid || txid.length !== 32 || !outputIndex || outputIndex.length !== 4) throw new Error('The PSBT v2 contains an incomplete input outpoint.')
    return { txid: bytesToHex(txid, true), vout: readLittleEndian(outputIndex), sequence: sequenceBytes ? readLittleEndian(sequenceBytes) : 0xffffffff }
  })
  const requiredTime = inputMaps.map(map => psbtMapValue(map, 0x11)).filter(Boolean)
  const requiredHeight = inputMaps.map(map => psbtMapValue(map, 0x12)).filter(Boolean)
  const requiresTime = inputMaps.some(map => psbtMapValue(map, 0x11) && !psbtMapValue(map, 0x12))
  const requiresHeight = inputMaps.some(map => psbtMapValue(map, 0x12) && !psbtMapValue(map, 0x11))
  if (requiresTime && requiresHeight) throw new Error('The PSBT v2 mixes incompatible required locktimes.')
  const fallbackLocktime = fallbackLocktimeBytes ? readLittleEndian(fallbackLocktimeBytes) : 0
  const locktimes = requiresTime ? requiredTime : requiresHeight ? requiredHeight : requiredHeight.length ? requiredHeight : requiredTime
  const locktime = locktimes.length ? locktimes.map(value => readLittleEndian(value)).reduce((maximum, value) => Math.max(maximum, value), 0) : fallbackLocktime
  const vout = outputMaps.map(map => {
    const amountBytes = psbtMapValue(map, 0x03)
    const scriptBytes = psbtMapValue(map, 0x04)
    if (!amountBytes || amountBytes.length !== 8 || !scriptBytes) throw new Error('The PSBT v2 contains an incomplete output.')
    const satoshis = readLittleEndian(amountBytes)
    if (satoshis < 0) throw new Error('The PSBT contains a negative output amount.')
    return { value: satoshis / 100_000_000, scriptPubKey: { hex: bytesToHex(scriptBytes) } }
  })
  if (reader.offset !== reader.length) throw new Error('The PSBT contains trailing map data.')
  return { version: readLittleEndian(versionBytes, true), locktime, vin, vout }
}
function parsePsbtTransaction(psbtBase64) {
  const bytes = psbtBytesFromBase64(psbtBase64)
  const reader = psbtReader(bytes)
  if (bytesToHex(reader.readBytes(5)) !== '70736274ff') throw new Error('The node returned data that is not a valid PSBT.')
  const globalMap = readPsbtMap(reader)
  const unsignedTransaction = psbtMapValue(globalMap, 0x00)
  if (unsignedTransaction) return { ...parseUnsignedTransaction(unsignedTransaction), psbtVersion: 0 }
  const versionBytes = psbtMapValue(globalMap, 0xfb)
  if (!versionBytes || versionBytes.length !== 4 || readLittleEndian(versionBytes) !== 2) throw new Error('The PSBT has no inspectable unsigned transaction.')
  return { ...parsePsbtV2Transaction(reader, globalMap), psbtVersion: 2 }
}
function mergeTransactionDecode(decoded, parsedTransaction) {
  const rpcVout = decoded?.tx?.vout || decoded?.vout || decoded?.transaction?.vout || []
  const vout = parsedTransaction.vout.map((output, index) => {
    const details = decodedOutputDetails(rpcVout[index] || {}, index)
    const parsedScript = output.scriptPubKey.hex.toLowerCase()
    const scriptPubKey = { hex: parsedScript }
    if (details.script === parsedScript) {
      const original = rpcVout[index]?.scriptPubKey ?? rpcVout[index]?.script
      if (original && typeof original === 'object') {
        if (original.address) scriptPubKey.address = original.address
        if (Array.isArray(original.addresses)) scriptPubKey.addresses = original.addresses
      }
    }
    return { ...output, scriptPubKey }
  })
  const transaction = { ...(decoded?.tx || {}), ...parsedTransaction, vout }
  if (decoded && typeof decoded === 'object') decoded.tx = transaction
  return transaction
}
async function addOutputAddressLabels(outputs) {
  return Promise.all(outputs.map(async output => {
    if (output.address !== 'FRIO output' || !output.script) return output
    try {
      const decodedScript = await rpc('decodescript', [output.script], false)
      const address = decodedScript.address || decodedScript.segwit?.address || decodedScript.addresses?.[0] || decodedScript.segwit?.addresses?.[0]
      if (address) { output.address = address; output.addresses = [address] }
    } catch { /* The script and amount remain visible if this optional label RPC is unavailable. */ }
    return output
  }))
}
async function createAirGapPsbt(recipient, amount, feeRate) {
  // First let Core select the inputs, then rebuild with those exact inputs and
  // route change back to the first selected input's address.
  const selectionParams = [[], { [recipient]: amount }, 0, { includeWatching: true, add_inputs: true, changePosition: 1, fee_rate: feeRate }, true]
  const selected = await createFundedPsbt(selectionParams)
  const transaction = parsePsbtTransaction(selected.psbt)
  const unspent = await rpc('listunspent', [0, 9999999], true)
  const byOutpoint = new Map((unspent || []).map(item => [`${String(item.txid).toLowerCase()}:${Number(item.vout)}`, item]))
  const selectedInputs = await Promise.all(transaction.vin.map(async (input, index) => {
    const outpoint = `${input.txid.toLowerCase()}:${Number(input.vout)}`
    const utxo = byOutpoint.get(outpoint)
    if (!utxo) throw new Error(`Could not match selected input #${index} to a source address in the watch-only wallet. No signing QR was created.`)
    let address = utxo.address
    if (!address) {
      const script = typeof utxo.scriptPubKey === 'string' ? utxo.scriptPubKey : utxo.scriptPubKey?.hex
      if (script) {
        const decoded = await rpc('decodescript', [script], false)
        address = decoded.address || decoded.segwit?.address || decoded.addresses?.[0] || decoded.segwit?.addresses?.[0]
      }
    }
    return { txid: input.txid, vout: input.vout, sequence: input.sequence, address, amount: Number(utxo.amount ?? utxo.value), scriptPubKey: utxo.scriptPubKey }
  }))
  const changeAddress = selectedInputs[0]?.address
  if (typeof changeAddress !== 'string' || !changeAddress.startsWith('frio1q')) {
    throw new Error('The selected input has no FRIO native SegWit source address. The app cannot safely choose a change destination.')
  }
  const sourceInfo = await rpc('validateaddress', [changeAddress], false)
  if (!sourceInfo.isvalid || !/^0014[0-9a-f]{40}$/i.test(String(sourceInfo.scriptPubKey || ''))) {
    throw new Error('The first selected input is not a valid FRIO native SegWit address. No signing QR was created.')
  }
  const inputs = selectedInputs.map(({ txid, vout, sequence }) => ({ txid, vout, sequence }))
  const options = { includeWatching: true, add_inputs: false, changeAddress, changePosition: 1, fee_rate: feeRate }
  const standardParams = [inputs, { [recipient]: amount }, 0, options, true]
  const funded = await createFundedPsbt(standardParams)
  return {
    ...funded,
    changeAddress,
    changeScript: String(sourceInfo.scriptPubKey).toLowerCase(),
    inputAddresses: [...new Set(selectedInputs.map(input => input.address))],
    inputDetails: selectedInputs.map(({ txid, vout, address, amount }) => ({ txid, vout, address, amount }))
  }
}
async function createFundedPsbt(standardParams) {
  const send = async (params, includeVersion) => {
    try {
      // AirGap is most compatible with classic BIP174 PSBT v0.
      return await rpc('walletcreatefundedpsbt', includeVersion ? [...params, 2, 0] : params, true)
    } catch (error) {
      const message = String(error.message || error)
      if (includeVersion && /too many|wrong number|expected\s+\d+\s*(?:to\s*\d+\s*)?(?:arguments?|parameters?)|(?:arguments?|parameters?)\s+expected/i.test(message)) return send(params, false)
      const options = params[3]
      const rejectsSatVbOption = options?.fee_rate && /fee_rate/i.test(message) && /unknown|unrecognized|unexpected|not recognized|invalid parameter|named parameter/i.test(message)
      if (rejectsSatVbOption && !options.feeRate) {
        // Older Core forks name the same explicit sat/vB setting `feeRate`
        // and express it in BTC/kvB. Never retry without the requested fee.
        const legacyParams = [...params]
        legacyParams[3] = { ...options, feeRate: Number(options.fee_rate) / 100000 }
        delete legacyParams[3].fee_rate
        return send(legacyParams, includeVersion)
      }
      throw error
    }
  }
  return send(standardParams, true)
}
async function prepareTransfer(event) {
  event.preventDefault()
  const enteredRecipient = $('#recipient').value.trim()
  const amountText = $('#amount').value.trim()
  const feeRateText = $('#feeRate').value.trim()
  const feeRate = Number(feeRateText)
  if (!state.connected || !state.account) { toast('Connect and pair a watch-only account first.', true); return }
  const recipient = enteredRecipient.toLowerCase().startsWith('bc1')
    ? bitcoinToFrioAddress(enteredRecipient)
    : decodeSegwitAddress(enteredRecipient, 'frio') ? enteredRecipient.toLowerCase() : enteredRecipient
  const recipientDecoded = recipient ? decodeSegwitAddress(recipient, 'frio') : null
  if (!recipientDecoded || !expectedWitnessScript(recipientDecoded)) { toast('Enter a valid FRIO SegWit address, or a valid Bitcoin bc1q / Taproot bc1p address.', true); return }
  if (!isValidAmount(amountText)) { toast('Enter an amount greater than zero, with up to eight decimals.', true); return }
  if (!isValidFeeRate(feeRateText)) { toast('Enter a manual fee rate from 0.1 to 1000 sat/vB, using up to three decimal places.', true); return }
  if (!Number.isFinite(state.balance)) { toast('The wallet balance is unavailable. Refresh the wallet before preparing a transfer.', true); return }
  if (Number(amountText) > state.balance) { toast(`The amount exceeds the available ${formatFrio(state.balance, 8)} FRIO balance.`, true); return }
  if (recipient !== enteredRecipient) {
    $('#recipient').value = recipient
    $('#recipient').dispatchEvent(new Event('input', { bubbles: true }))
  }
  const submit = $('#prepareButton')
  submit.disabled = true; submit.textContent = 'Preparing PSBT…'
  try {
    const addressInfo = await rpc('validateaddress', [recipient], false)
    if (!addressInfo.isvalid) throw new Error('The recipient address is not valid on this network.')
    const recipientScript = String(addressInfo.scriptPubKey || '').toLowerCase()
    if (!/^(?:[0-9a-f]{2})+$/.test(recipientScript)) throw new Error('The node did not return the recipient output script, so the transfer cannot be verified safely.')
    const expectedScript = expectedWitnessScript(recipientDecoded)
    if (recipientScript !== expectedScript) throw new Error(`The converted FRIO address does not match the expected ${recipientDecoded.version === 1 ? 'Taproot' : 'SegWit'} output script. No signing QR was created.`)
    const amount = Number(amountText)
    const funded = await createAirGapPsbt(recipient, amount, feeRate)
    const originalTransaction = parsePsbtTransaction(funded.psbt)
    if (originalTransaction.psbtVersion !== 0) {
      throw new Error(`Friotaíoch Core returned PSBT version ${originalTransaction.psbtVersion} after the app requested version 0. AirGap Vault's Bitcoin signer needs the classic PSBT v0 format here, so no signing QR was shown. Update Friotaíoch Core or send this message with its version to the wallet maintainer.`)
    }
    // PSBT_IN_SIGHASH_TYPE is optional in BIP174. Include SIGHASH_ALL explicitly
    // because some offline signers handle that classic v0 field more reliably.
    const signingPsbt = addExplicitSighashAll(funded.psbt)
    const decoded = await rpc('decodepsbt', [signingPsbt], false)
    const parsedTransaction = parsePsbtTransaction(signingPsbt)
    const transaction = mergeTransactionDecode(decoded, parsedTransaction)
    const outputs = await addOutputAddressLabels(transaction.vout.map(decodedOutputDetails))
    for (const output of outputs) {
      if (output.script === funded.changeScript) {
        output.address = funded.changeAddress
        output.addresses = [...new Set([...output.addresses, funded.changeAddress])]
      }
    }
    transaction.vout = outputs.map(output => ({ value: output.amount, scriptPubKey: { hex: output.script, address: output.address } }))
    const requestedSatoshis = Number(amountToSatoshis(amountText))
    const recipientOutput = outputs.find(output => Math.round(output.amount * 100_000_000) === requestedSatoshis && (output.script
      ? output.script === recipientScript
      : output.addresses.includes(recipient)))
    if (!recipientOutput) {
      const observed = outputs.length
        ? outputs.slice(0, 8).map(output => `#${output.index} ${output.address} amount=${output.amount} script=${output.script || '(not returned)'}`).join('; ')
        : 'the node returned no inspectable transaction outputs'
      const mismatch = new Error(`The prepared PSBT does not contain an output paying the script for your FRIO address. Expected script ${recipientScript}; decoded outputs: ${observed}. No QR was shown.`)
      mismatch.name = 'PsbtOutputMismatchError'
      throw mismatch
    }
    if (!Number.isFinite(recipientOutput.amount) || Math.round(recipientOutput.amount * 100_000_000) !== requestedSatoshis) {
      throw new Error(`The prepared PSBT recipient amount does not match ${amountText} FRIO. No QR was shown.`)
    }
    // Use the exact FRIO address the user entered, even if Core displays another network's HRP for the same script.
    recipientOutput.address = recipient
    state.unsignedPsbt = { psbt: signingPsbt, decoded, recipient, amount, fee: Number(funded.fee || 0), feeRate, outputs, changeAddress: funded.changeAddress, inputAddresses: funded.inputAddresses, inputDetails: funded.inputDetails, recipientOutputIndex: recipientOutput.index }
    $('#feeEstimate').textContent = `${feeRate} sat/vB · ${formatFrio(funded.fee)} FRIO`
    showTransferReview()
  } catch (error) {
    if (error.name === 'PsbtOutputMismatchError') {
      modal('PSBT output mismatch', `<p class="modal-copy">The node prepared a transaction whose decoded outputs do not match the destination you entered. No signing QR was created. Copy this diagnostic and send it back so the node response can be matched exactly.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:32vh;overflow:auto">${esc(error.message)}</pre><div class="modal-actions"><button class="button button-quiet" id="copyOutputDiagnostic">Copy diagnostic</button><button class="button button-primary" id="closeOutputDiagnostic">Close</button></div>`, 'TRANSFER BLOCKED')
      $('#copyOutputDiagnostic').addEventListener('click', () => copyText(error.message))
      $('#closeOutputDiagnostic').addEventListener('click', closeModal)
    } else toast(error.message, true)
  }
  finally { submit.disabled = false; submit.innerHTML = 'Review transfer <span>→</span>' }
}
function showTransferReview() {
  const tx = state.unsignedPsbt
  if (!tx) return
  const outputRows = tx.outputs.map(output => {
    const label = output.index === tx.recipientOutputIndex ? 'Recipient' : output.address === tx.changeAddress ? 'Change · first input address' : 'Other output'
    return `<div class="review-row review-address-row"><span>${label}</span><div class="review-address-details">${addressComparisonHtml(output.address)}<strong>${formatFrio(output.amount)} FRIO</strong></div></div>`
  }).join('')
  modal('Review transfer', `<p class="modal-copy">Check the recipient, amount, network fee and every output before sending this unsigned transaction to AirGap Vault. Orange marks BTC-only characters, green marks FRIO-only characters, and the shared address data stays neutral.</p>
    <div class="review-box"><div class="review-row"><span>Network</span><strong>Friotaíoch mainnet · ${decodeSegwitAddress(tx.recipient, 'frio')?.version === 1 ? 'Taproot output' : 'SegWit output'}</strong></div><div class="review-row"><span>Signing format</span><strong>PSBT v0 · SIGHASH_ALL</strong></div><div class="review-row"><span>Recipient amount</span><strong class="review-emphasis">${formatFrio(tx.amount)} FRIO</strong></div><div class="review-row"><span>Fee rate</span><strong>${tx.feeRate} sat/vB</strong></div><div class="review-row"><span>Network fee</span><strong>${formatFrio(tx.fee)} FRIO</strong></div>${outputRows}<div class="review-row"><span>Inputs</span><strong>${(tx.decoded.tx?.vin || []).length} UTXO${(tx.decoded.tx?.vin || []).length === 1 ? '' : 's'}</strong></div></div>
    <label class="confirm-line"><input id="reviewConfirm" type="checkbox"><span>I checked the destination and amount. I will confirm the same details on AirGap Vault.</span></label><div id="reviewError"></div>
    <div class="modal-actions"><button class="button button-quiet" data-close>Cancel</button><button class="button button-primary" id="showUnsignedQr" disabled>Show signing QR <span>→</span></button></div>`, 'PREPARE OFFLINE SIGNATURE')
  $('#reviewConfirm').addEventListener('change', event => { $('#showUnsignedQr').disabled = !event.currentTarget.checked })
  $('#showUnsignedQr').addEventListener('click', showUnsignedQr)
  $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
}
function btcAmountToSatoshis(value) {
  if (value === undefined || value === null || value === '') return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  try { return amountToSatoshis(amount.toFixed(8)) } catch { return null }
}
function formatBtc(value) {
  return Number.isFinite(Number(value)) ? `${formatFrio(value, 8)} BTC` : 'Unavailable'
}
function derivationPathForFingerprint(derivations, fingerprint) {
  const item = (Array.isArray(derivations) ? derivations : []).find(entry =>
    String(entry.master_fingerprint || '').replace(/^0x/i, '').toLowerCase() === String(fingerprint || '').toLowerCase())
  if (!item?.path) return ''
  const path = String(item.path).replace(/[hH](?=\/|$)/g, "'")
  return /^m\//i.test(path) ? path : `m/${path}`
}
function airGapComparisonMarkup(tx) {
  const fingerprint = String(state.account?.fingerprint || '').toLowerCase()
  const accountAddress = state.addresses.find(item => item.index === 0)?.address
  const inputDetails = Array.isArray(tx.inputDetails) ? tx.inputDetails : []
  const decodedInputs = Array.isArray(tx.decoded?.inputs) ? tx.decoded.inputs : []
  const inputDetailsByOutpoint = new Map(inputDetails.map(input => [`${String(input.txid || '').toLowerCase()}:${Number(input.vout)}`, input]))
  const transactionInputs = Array.isArray(tx.decoded?.tx?.vin) ? tx.decoded.tx.vin : []
  const inputRows = (transactionInputs.length ? transactionInputs : inputDetails).map((vin, index) => {
    const outpoint = `${String(vin.txid || '').toLowerCase()}:${Number(vin.vout)}`
    const input = inputDetailsByOutpoint.get(outpoint) || inputDetails[index] || vin
    const psbtInput = decodedInputs[index] || {}
    const witnessAmount = Number(psbtInput.witness_utxo?.amount ?? psbtInput.witness_utxo?.value)
    const previousOutput = psbtInput.non_witness_utxo?.vout?.[Number(vin?.vout)]
    const previousAmount = Number(previousOutput?.value ?? previousOutput?.amount)
    const amount = Number.isFinite(witnessAmount) ? witnessAmount
      : Number.isFinite(previousAmount) ? previousAmount : input.amount
    const path = derivationPathForFingerprint(psbtInput.bip32_derivs, fingerprint)
    return { address: input.address, amount, path, index }
  })
  const inputSatoshis = inputRows.map(item => btcAmountToSatoshis(item.amount))
  const totalInputSatoshis = inputSatoshis.some(value => value === null)
    ? null : inputSatoshis.reduce((sum, value) => sum + value, 0n)
  const sourceGroups = new Map()
  for (const input of inputRows) {
    const key = input.address || `Input #${input.index + 1}`
    const current = sourceGroups.get(key) || { address: input.address, satoshis: 0n, hasAmounts: true, paths: new Set() }
    const satoshis = btcAmountToSatoshis(input.amount)
    if (satoshis === null) current.hasAmounts = false
    else current.satoshis += satoshis
    if (input.path) current.paths.add(input.path)
    sourceGroups.set(key, current)
  }
  const sourceRows = [...sourceGroups.values()].map((source, index) => {
    const amount = source.hasAmounts ? Number(source.satoshis) / 100_000_000 : NaN
    const path = [...source.paths].join(', ')
    return `<div class="airgap-flow-row"><div class="airgap-flow-title"><span>FROM${sourceGroups.size > 1 ? ` · ${index + 1}` : ''}</span><strong>${formatBtc(amount)}</strong></div>${source.address ? addressComparisonHtml(source.address) : '<span class="airgap-no-address">Source address unavailable</span>'}${path ? `<small>Signing path · ${esc(path)}</small>` : ''}</div>`
  }).join('') || '<div class="airgap-flow-row"><span class="airgap-no-address">Input source details unavailable</span></div>'
  const outputs = Array.isArray(tx.outputs) ? tx.outputs : []
  const operations = outputs.filter(output => output.index === tx.recipientOutputIndex).length
  const outputRows = outputs.map(output => {
    const isRecipient = output.index === tx.recipientOutputIndex
    const isChange = !isRecipient && output.address === tx.changeAddress
    const outputDetails = (Array.isArray(tx.decoded?.outputs) ? tx.decoded.outputs : [])[output.index] || {}
    const path = derivationPathForFingerprint(outputDetails.bip32_derivs, fingerprint)
    const label = isRecipient ? 'TO · RECIPIENT' : isChange ? 'TO · CHANGE ADDRESS' : 'TO · OTHER OUTPUT'
    const detail = isChange ? path ? `Change address · ${path}` : 'Change returns to the source address' : ''
    return `<div class="airgap-flow-row"><div class="airgap-flow-title"><span>${label}</span><strong>${formatBtc(output.amount)}</strong></div>${output.address ? addressComparisonHtml(output.address) : '<span class="airgap-no-address">Output address unavailable</span>'}${detail ? `<small>${esc(detail)}</small>` : ''}</div>`
  }).join('') || '<div class="airgap-flow-row"><span class="airgap-no-address">Output details unavailable</span></div>'
  const accountAddressMarkup = accountAddress
    ? addressComparisonHtml(accountAddress)
    : '<span class="airgap-no-address">BIP84 receive address is not available in this view.</span>'
  const totalAmount = totalInputSatoshis === null ? NaN : Number(totalInputSatoshis) / 100_000_000
  const fingerprintText = fingerprint ? `0x${fingerprint}` : 'Unavailable'
  return `<section class="airgap-review-card" aria-label="Expected AirGap transaction details">
    <div class="airgap-review-heading"><div><div class="eyebrow">COMPARE WITH AIRGAP VAULT</div><strong>Expected signing review</strong></div><span class="airgap-review-badge">PSBT v0</span></div>
    <div class="airgap-account-summary"><div class="airgap-account-copy"><strong>Bitcoin (SegWit) · BTC</strong><span>Signing account ${esc(fingerprintText)} · BIP84</span></div>${accountAddressMarkup}</div>
    <div class="airgap-review-stats"><div><span>Amount</span><strong>${formatBtc(totalAmount)}</strong><small>Total of source inputs</small></div><div><span>Operations</span><strong>${operations}</strong><small>Recipient payments</small></div><div><span>Fee</span><strong>${formatBtc(tx.fee)}</strong><small>Network fee</small></div></div>
    <div class="airgap-flow-list"><div class="airgap-flow-section-title">FROM</div>${sourceRows}<div class="airgap-flow-section-title">TO</div>${outputRows}</div>
    <p class="airgap-review-note">Compare the Bitcoin (bc1…) rows, amounts, operation count, and fee with AirGap before signing. FRIO equivalents are shown alongside.</p>
  </section>`
}
async function showUnsignedQr() {
  const rawPsbt = state.unsignedPsbt?.psbt
  if (!rawPsbt) return
  const readiness = inputDerivationReadiness()
  if (!readiness.count || readiness.matched !== readiness.count) {
    const report = airGapCompatibilityReport()
    modal('AirGap signing data is incomplete', `<p class="modal-copy">The PSBT does not show a matching BIP84 key derivation for every input in the paired AirGap account. Vault may scan the QR but cannot reliably find the signing key. No QR was created.</p><div class="review-box"><div class="review-row"><span>Inputs checked</span><strong>${readiness.count}</strong></div><div class="review-row"><span>Inputs matching paired account</span><strong>${readiness.matched} of ${readiness.count}</strong></div></div><p class="modal-copy">The report below omits addresses, amounts, txids, public keys, the PSBT, and RPC credentials. Select its text and copy manually if the button fails.</p>${diagnosticTextarea(report, 'preflightDiagnosticText')}<div class="modal-actions"><button class="button button-quiet" id="copyPreflightDiagnostic">Copy report</button><button class="button button-primary" data-close>Close</button></div>`, 'SIGNING PREFLIGHT')
    $('#copyPreflightDiagnostic').addEventListener('click', () => copyText(report))
    $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
    return
  }
  try {
    const encoded = await window.frioDesktop.createSigningQr(rawPsbt)
    modal('Scan with AirGap Vault', `<p class="modal-copy">This animated QR carries a BC-UR <code>crypto-psbt</code> in classic PSBT v0 format. In Vault, open your Bitcoin SegWit account and choose <b>Scan QR</b>. Compare the expected AirGap review beside the QR before approving. The one-frame and animated QRs use the same PSBT; no need to rescan both.</p><div class="airgap-qr-review-layout"><div class="airgap-qr-column"><div class="qr-stage"><div class="qr-paper"><img id="unsignedQrImage" alt="Unsigned FRIO crypto-psbt animated QR code" /></div><div class="qr-caption">Hold your AirGap phone camera over this screen.</div><div class="qr-counter" id="qrCounter">BC-UR · crypto-psbt · frame 1</div></div></div>${airGapComparisonMarkup(state.unsignedPsbt)}</div><div class="modal-actions"><button class="button button-quiet" id="cancelUnsigned">Cancel</button><button class="button button-secondary" id="trySingleFrameButton">One-frame QR</button><button class="button button-primary" id="scanSignedButton">Scan signed QR with camera <span>→</span></button></div>`, 'AIRGAP SIGNING')
    $('#modalBackdrop .modal').classList.add('airgap-review-modal')
    const image = $('#unsignedQrImage')
    const showFrame = async dataUrl => {
      image.src = dataUrl
      if (typeof image.decode === 'function') await image.decode()
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    await showFrame(encoded.dataUrl)
    let count = 1
    // modal() stops any previous signing QR, so register the new encoder after opening it.
    state.qrEncoderId = encoded.id
    const advanceFrame = async () => {
      const encoderId = encoded.id
      if (state.qrEncoderId !== encoderId || !$('#unsignedQrImage')) return
      try {
        const nextImage = await window.frioDesktop.nextSigningQr(encoderId)
        if (state.qrEncoderId !== encoderId || !$('#unsignedQrImage')) return
        await showFrame(nextImage)
        count += 1
        $('#qrCounter').textContent = `BC-UR · crypto-psbt · frame ${count}`
        state.qrTimer = setTimeout(advanceFrame, 700)
      } catch (error) {
        toast(`QR animation stopped: ${error.message}`, true)
        stopQr()
      }
    }
    state.qrTimer = setTimeout(advanceFrame, 700)
    $('#cancelUnsigned').addEventListener('click', closeModal)
    $('#trySingleFrameButton').addEventListener('click', () => showSingleFrameSigningQr(rawPsbt))
    $('#scanSignedButton').addEventListener('click', () => showSignedScanner())
  } catch (error) { toast(`Could not encode the PSBT QR: ${error.message}`, true) }
}
async function showSingleFrameSigningQr(psbtBase64) {
  try {
    const dataUrl = await window.frioDesktop.createSingleSigningQr(psbtBase64)
    modal('One-frame AirGap QR', `<p class="modal-copy">This is the same unsigned PSBT v0 in a single-frame BC-UR <code>crypto-psbt</code> QR. Compare the expected AirGap review beside the QR, then check the recipient and amount on Vault before approving.</p><div class="airgap-qr-review-layout"><div class="airgap-qr-column"><div class="qr-stage"><div class="qr-paper single-frame"><img id="singleFrameQrImage" alt="Single-frame unsigned FRIO crypto-psbt QR code" /></div><div class="qr-caption">Scan once with AirGap Vault → Bitcoin SegWit → Scan QR.</div><div class="qr-counter">Single-frame BC-UR · crypto-psbt · PSBT v0</div></div></div>${airGapComparisonMarkup(state.unsignedPsbt)}</div><div class="modal-actions"><button class="button button-quiet" id="cancelSingleFrame">Cancel</button><button class="button button-secondary" id="backToAnimatedQr">Back to animated QR</button><button class="button button-primary" id="scanSignedButton">Scan signed QR with camera <span>→</span></button></div>`, 'AIRGAP SIGNING')
    $('#modalBackdrop .modal').classList.add('airgap-review-modal')
    const image = $('#singleFrameQrImage')
    image.src = dataUrl
    if (typeof image.decode === 'function') await image.decode()
    $('#cancelSingleFrame').addEventListener('click', closeModal)
    $('#backToAnimatedQr').addEventListener('click', showUnsignedQr)
    $('#scanSignedButton').addEventListener('click', showSignedScanner)
  } catch (error) {
    toast(`One-frame QR unavailable: ${error.message}`, true)
  }
}
function showSignedScanner() {
  state.lastFrame = ''
  modal('Scan signed transaction', `<p class="modal-copy">After approving the transfer, return to AirGap Vault's signed <code>crypto-psbt</code> QR. Hold it in view until the unique-fragment counter reaches completion. The scanner also accepts a single-frame base64 PSBT QR.</p><div class="camera-frame"><video id="signedVideo" muted playsinline></video><div class="camera-hint">Keep the signed QR centered in the camera preview.</div></div><div class="scan-progress"><span id="signedProgress"></span></div><div class="scan-status" id="signedStatus">Camera is off.</div><div id="signedError"></div><div class="modal-actions"><button class="button button-quiet" id="stopSignedScan">Cancel</button><button class="button button-primary" id="openSignedCamera">Open camera</button></div>`, 'RETURN SIGNED PSBT')
  $('#openSignedCamera').addEventListener('click', () => startCamera('signed'))
  $('#stopSignedScan').addEventListener('click', closeModal)
}
async function startCamera(mode) {
  stopCamera()
  state.scanMode = mode
  const generation = state.scanGeneration
  state.qrFrameQueue = Promise.resolve()
  state.incomingDecoderId = await window.frioDesktop.beginQrScan()
  if (generation !== state.scanGeneration || $('#modalBackdrop').classList.contains('hidden')) {
    window.frioDesktop.endQrScan(state.incomingDecoderId)
    state.incomingDecoderId = null
    return
  }
  state.lastFrame = ''
  let detectedFrames = 0
  const video = mode === 'pair' ? $('#pairVideo') : $('#signedVideo')
  const status = mode === 'pair' ? $('#pairStatus') : $('#signedStatus')
  const progress = mode === 'pair' ? $('#pairProgress') : $('#signedProgress')
  state.scanning = true
  try {
    const reader = new window.QrScanner(video, async result => {
      if (!result || !state.scanning) return
      const value = typeof result === 'string' ? result : result.data
      if (!value || value === state.lastFrame) return
      state.lastFrame = value
      detectedFrames += 1
      state.qrFrameQueue = state.qrFrameQueue.then(async () => {
        if (!state.scanning || generation !== state.scanGeneration) return
        await processCameraFrame(value, mode, status, progress)
        if (!value.toLowerCase().startsWith('ur:')) state.lastFrame = ''
      }).catch(error => {
        if (generation !== state.scanGeneration) return
        status.textContent = `Could not process the scanned QR: ${error.message}`
      })
    }, { preferredCamera: 'environment', returnDetailedScanResult: true, maxScansPerSecond: 8, highlightScanRegion: false, highlightCodeOutline: false })
    state.scanner = reader
    await reader.start()
    state.cameraControls = reader
    if (!detectedFrames) status.textContent = mode === 'pair' ? 'Camera ready. Show the AirGap account QR.' : 'Camera ready. Hold the signed AirGap QR in view; scanned frame progress will appear here.'
  } catch (error) {
    stopCamera()
    status.textContent = error.name === 'NotAllowedError' ? 'Camera permission was denied.' : `Could not open camera: ${error.message}`
  }
}
function isPsbtBase64(value) {
  const candidate = String(value || '').trim()
  if (!candidate.startsWith('cHNidP8') || candidate.length > 100_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate)) return false
  try { return atob(candidate).startsWith('psbt\xff') } catch { return false }
}
async function processCameraFrame(value, mode, status, progress) {
  try {
    if (!value.toLowerCase().startsWith('ur:')) {
      if (mode === 'pair' && /wpkh\(/i.test(value)) {
        $('#accountDescriptor').value = value
        status.textContent = 'Public account QR read. Select Add wallet to continue.'
      } else if (mode === 'signed' && isPsbtBase64(value)) {
        progress.style.width = '100%'
        status.textContent = 'Single-frame PSBT QR received. Checking the signature…'
        stopCamera()
        await verifySignedPsbt(value.trim())
      } else if (mode === 'signed') {
        status.textContent = 'QR detected, but it is not a signed PSBT. In AirGap, return the signed transaction from Bitcoin SegWit as a crypto-psbt QR.'
      }
      return
    }
    const result = await window.frioDesktop.readQrFrame(state.incomingDecoderId, value)
    if (!result.done) {
      const percent = Math.max(0, Math.min(99, Math.round(Number(result.progress || 0) * 100)))
      const count = result.expectedParts > 0 ? ` · ${result.receivedParts}/${result.expectedParts} parts` : ''
      const accepted = result.accepted === false ? ' · repeated frame' : ''
      status.textContent = `Receiving ${String(result.type || 'UR').toUpperCase()}${count} · ${percent}%${accepted}`
      progress.style.width = `${Math.max(percent, 4)}%`
      return
    }
    if (result.type === 'error') throw new Error(`AirGap UR decode failed: ${result.error || 'invalid animated QR'}`)
    if (mode === 'pair') {
      if (result.type !== 'descriptor') throw new Error('This AirGap QR did not contain a single-signature SegWit output descriptor. Use the Sparrow companion option.')
      $('#accountDescriptor').value = result.payload
      progress.style.width = '100%'
      status.textContent = 'AirGap SegWit account QR received. Select Add wallet to continue.'
      stopCamera()
      return
    }
    if (result.type !== 'psbt') {
      stopCamera()
      const foundType = result.payload || result.urType || result.type || 'non-PSBT'
      throw new Error(`AirGap completed a ${String(foundType)} QR, not a signed crypto-psbt. In AirGap Vault, return to the Bitcoin SegWit transaction and display its signed PSBT QR.`)
    }
    progress.style.width = '100%'
    status.textContent = 'Signed PSBT received. Checking the transaction…'
    stopCamera()
    await verifySignedPsbt(result.payload)
  } catch (error) {
    if (mode === 'pair') status.textContent = error.message
    else {
      status.textContent = `Could not complete the signed QR: ${error.message}`
      $('#signedError').innerHTML = `<div class="inline-error">${esc(error.message)}</div>`
    }
  }
}
function stopCamera() {
  state.scanGeneration += 1
  state.scanning = false
  state.qrFrameQueue = Promise.resolve()
  if (state.cameraControls?.stop) state.cameraControls.stop()
  if (state.scanner?.destroy) state.scanner.destroy()
  state.cameraControls = null
  state.scanner = null
  if (state.incomingDecoderId) window.frioDesktop.endQrScan(state.incomingDecoderId)
  state.incomingDecoderId = null
}
function stopQr() {
  if (state.qrTimer) clearTimeout(state.qrTimer)
  state.qrTimer = null
  if (state.qrEncoderId) window.frioDesktop.stopSigningQr(state.qrEncoderId)
  state.qrEncoderId = null
}
function transactionShape(decoded) {
  const tx = decoded?.tx
  if (!tx) throw new Error('The PSBT has no unsigned transaction to inspect.')
  return JSON.stringify({
    version: tx.version,
    locktime: tx.locktime,
    vin: (tx.vin || []).map(input => ({ txid: input.txid, vout: input.vout, sequence: input.sequence })),
    vout: (tx.vout || []).map(output => ({ value: Number(output.value), script: output.scriptPubKey?.hex || '' }))
  })
}
async function verifySignedPsbt(signedPsbt) {
  try {
    if (!state.unsignedPsbt) throw new Error('The prepared transaction expired. Prepare it again before signing.')
    const parsedSignedTransaction = parsePsbtTransaction(signedPsbt)
    const decodedSigned = await rpc('decodepsbt', [signedPsbt], false)
    mergeTransactionDecode(decodedSigned, parsedSignedTransaction)
    if (transactionShape(decodedSigned) !== transactionShape(state.unsignedPsbt.decoded)) throw new Error('The signed QR changed the transaction outputs or inputs. It was rejected and will not be broadcast.')
    const signedInputs = Array.isArray(decodedSigned.inputs) ? decodedSigned.inputs : []
    const hasSignature = input => countMapFields(input.partial_signatures) > 0 ||
      countMapFields(input.taproot_key_path_sig) > 0 ||
      !!input.final_scriptsig ||
      (Array.isArray(input.final_scriptwitness) && input.final_scriptwitness.length > 0)
    if (!signedInputs.length || signedInputs.some(input => !hasSignature(input))) throw new Error('AirGap returned the PSBT, but at least one input has no signature. Keep scanning the signed QR from AirGap Vault after approving the transaction.')
    state.signedPsbt = signedPsbt
    state.signedDecoded = decodedSigned
    const tx = state.unsignedPsbt
    const recipient = tx.outputs.find(output => output.address === tx.recipient)
    const rows = `<div class="review-row"><span>Network</span><strong>Friotaíoch mainnet · verified</strong></div><div class="review-row review-address-row"><span>Recipient</span><div class="review-address-details">${addressComparisonHtml(tx.recipient)}<strong class="review-emphasis">${formatFrio(recipient?.amount)} FRIO</strong></div></div><div class="review-row"><span>Fee rate</span><strong>${tx.feeRate} sat/vB</strong></div><div class="review-row"><span>Network fee</span><strong>${formatFrio(tx.fee)} FRIO</strong></div><div class="review-row"><span>Transaction ID</span><strong>Available after broadcast</strong></div>`
    modal('Signed transaction ready', `<p class="modal-copy">AirGap returned a signature. The desktop checked that the inputs and outputs are unchanged from the transfer you reviewed.</p><div class="review-box">${rows}</div><label class="confirm-line"><input id="broadcastConfirm" type="checkbox"><span>I have reviewed the FRIO recipient and amount. Broadcast this signed transaction to mainnet.</span></label><div id="broadcastError"></div><div class="modal-actions"><button class="button button-quiet" id="discardSigned">Discard</button><button class="button button-primary" id="broadcastButton" disabled>Broadcast FRIO <span>→</span></button></div>`, 'FINAL CHECK')
    $('#broadcastConfirm').addEventListener('change', event => { $('#broadcastButton').disabled = !event.currentTarget.checked })
    $('#discardSigned').addEventListener('click', () => { state.unsignedPsbt = null; state.signedPsbt = null; closeModal() })
    $('#broadcastButton').addEventListener('click', broadcastSignedPsbt)
  } catch (error) {
    modal('Signature rejected', `<p class="modal-copy">This signed QR was not accepted. The prepared transfer remains unchanged and nothing was broadcast.</p><div class="inline-error">${esc(error.message)}</div><div class="modal-actions"><button class="button button-primary" data-close>Close</button></div>`, 'TRANSACTION CHECK')
    $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
  }
}
function showHelpModal() {
  modal('AirGap signing flow', `<p class="modal-copy">The FRIO desktop keeps a public descriptor only. The signing secret stays inside AirGap Vault on your offline phone.</p><div class="review-box"><div class="review-row"><span>1 · Account</span><strong>AirGap Bitcoin SegWit account, BIP84</strong></div><div class="review-row"><span>2 · Receive</span><strong>FRIO Core derives addresses using the FRIO network prefix</strong></div><div class="review-row"><span>3 · Prepare</span><strong>The local node builds a standard SegWit PSBT</strong></div><div class="review-row"><span>4 · Sign</span><strong>AirGap Vault signs over animated crypto-psbt QR</strong></div><div class="review-row"><span>5 · Broadcast</span><strong>The app checks outputs are unchanged, then broadcasts</strong></div></div><div class="modal-note">Use only the Bitcoin SegWit account on your Vault. The app does not ask for a recovery phrase, private key, or quantum-resistant account.</div><div class="modal-actions"><button class="button button-primary" data-close>Got it</button></div>`, 'OFFLINE SIGNING')
  $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
}
async function broadcastSignedPsbt() {
  const button = $('#broadcastButton')
  button.disabled = true; button.textContent = 'Finalizing…'
  try {
    const final = await rpc('finalizepsbt', [state.signedPsbt, true], false)
    if (!final.complete || !final.hex) throw new Error('AirGap has not provided all required signatures. No transaction was broadcast.')
    button.textContent = 'Broadcasting…'
    const txid = await rpc('sendrawtransaction', [final.hex], false)
    const sent = state.unsignedPsbt
    state.lastAmount = sent?.amount || 0
    state.lastRecipient = sent?.recipient || ''
    state.unsignedPsbt = null; state.signedPsbt = null
    modal('FRIO transfer broadcast', `<div class="success-mark">✓</div><p class="modal-copy success-copy">Your signed transaction was sent to the Friotaíoch node.</p><div class="review-box"><div class="review-row"><span>Amount</span><strong class="review-emphasis">${formatFrio(state.lastAmount)} FRIO</strong></div><div class="review-row"><span>Recipient</span><strong>${esc(state.lastRecipient)}</strong></div><div class="review-row"><span>Transaction ID</span><strong class="txid-value">${esc(txid)}</strong></div></div><div class="modal-actions"><button class="button button-primary" data-close>Done</button></div>`, 'BROADCAST COMPLETE')
    $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
    await refreshWallet()
  } catch (error) {
    $('#broadcastError').innerHTML = `<div class="inline-error">${esc(error.message)}</div>`
    button.disabled = false; button.innerHTML = 'Broadcast FRIO <span>→</span>'
  }
}
// Navigation and actions
$$('.nav-item[data-page]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.page)))
$$('[data-nav]').forEach(button => button.addEventListener('click', () => showPage(button.dataset.nav)))
$('#walletSelector').addEventListener('change', event => {
  const identity = event.currentTarget.value
  if (identity) void switchSavedWallet(identity)
  else renderWalletSelector()
})
$('#connectButton').addEventListener('click', showConnectionModal)
$('#settingsButton').addEventListener('click', () => showPage('settings'))
$('#nodeSettingsLink').addEventListener('click', () => showPage('settings'))
$('#pairButton').addEventListener('click', () => state.connected ? showPairModal() : showConnectionModal())
$('#settingsPairButton').addEventListener('click', () => state.connected ? showPairModal() : showConnectionModal())
$('#securityLink').addEventListener('click', showHelpModal)
$('#refreshButton').addEventListener('click', refreshWallet)
$('#activityRefresh').addEventListener('click', refreshWallet)
$('#receiveButton').addEventListener('click', () => { if (!state.connected) showConnectionModal(); else if (!state.account) showPairModal(); else showPage('receive') })
$('#newAddressButton').addEventListener('click', getReceiveAddress)
$('#copyAddress').addEventListener('click', () => state.currentAddress && copyText(state.currentAddress))
$('#sendForm').addEventListener('submit', prepareTransfer)
$('#feeRate').value = String(state.feeRate)
$('#feeEstimate').textContent = `${state.feeRate} sat/vB`
$('#feeRate').addEventListener('change', () => {
  const value = $('#feeRate').value.trim()
  if (!isValidFeeRate(value)) return
  state.feeRate = Number(value)
  localStorage.setItem(FEE_RATE_KEY, String(state.feeRate))
  $('#feeEstimate').textContent = `${state.feeRate} sat/vB`
})
$('#recipient').addEventListener('input', () => {
  const input = $('#recipient').value.trim()
  const equivalent = $('#recipientEquivalent')
  const frioAddress = decodeSegwitAddress(input, 'frio') ? input.toLowerCase() : bitcoinToFrioAddress(input)
  const hasEquivalent = Boolean(frioAddress && bitcoinEquivalentAddress(frioAddress))
  equivalent.hidden = !hasEquivalent
  equivalent.innerHTML = hasEquivalent ? `${input.toLowerCase().startsWith('bc1') ? '<div class="recipient-conversion-note">Bitcoin address will be converted to the matching FRIO output.</div>' : ''}${addressComparisonHtml(frioAddress)}` : ''
})
$('#forgetAccountButton').addEventListener('click', () => {
  if (!state.account) { toast('No account descriptor to forget.'); return }
  modal('Forget public account?', `<p class="modal-copy">This clears the local public descriptor from this app. The watch-only descriptor will still be present in Friotaíoch Core until that wallet is removed there.</p><div class="modal-actions"><button class="button button-quiet" data-close>Keep account</button><button class="button button-primary" id="confirmForget">Forget descriptor</button></div>`, 'PUBLIC ACCOUNT')
  $('#modalContent').querySelector('[data-close]').addEventListener('click', closeModal)
  $('#confirmForget').addEventListener('click', () => { saveAccount(null); state.currentAddress = ''; state.currentAddressIndex = 0; state.addresses = []; state.addressError = ''; state.balance = null; state.transactions = []; state.transactionsError = ''; $('#balanceValue').textContent = '—'; $('#availableBalance').textContent = '— FRIO'; $('#balanceCaption').textContent = 'Awaiting wallet connection'; closeModal(); updateAccountState(); renderAddresses(); renderReceive(); renderTransactions('#recentActivity', []); renderTransactions('#fullActivity', []); toast('Local public descriptor forgotten.') })
})
$('#modalClose').addEventListener('click', closeModal)
$('#modalBackdrop').addEventListener('click', event => { if (event.target === $('#modalBackdrop')) closeModal() })
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal() })
$$('[data-external]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); window.frioDesktop.openExternal(link.href) }))

// Save node credentials through the desktop main process, which encrypts them with OS secure storage.
$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault()
  state.rpcUrl = $('#rpcUrl').value.trim()
  state.username = $('#rpcUser').value.trim()
  state.password = $('#rpcPassword').value
  state.autoConnect = $('#autoConnect').checked
  const button = event.currentTarget.querySelector('[type="submit"]')
  button.disabled = true; button.textContent = 'Connecting…'
  try {
    await connectNode()
    const saved = await persistConnectionSettings()
    if (saved) toast('Connected to Friotaíoch mainnet.')
    if (!state.account) showPairModal()
  } catch (error) { toast(error.message, true) }
  finally { button.disabled = false; button.innerHTML = 'Connect to mainnet <span>→</span>' }
})

$('#autoConnect').addEventListener('change', async event => {
  state.autoConnect = event.currentTarget.checked
  if (state.username && state.password) await persistConnectionSettings()
})

connectedUi(false)
updateAccountState()
renderReceive()
renderAddresses()
renderTransactions('#recentActivity', [])
renderTransactions('#fullActivity', [])
void restoreConnectionSettings()
