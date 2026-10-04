# Friotaíoch AirGap Wallet

An early desktop wallet coordinator for the classic SegWit v0 (P2WPKH) address type on FRIO mainnet. The desktop wallet is watch-only: it keeps an AirGap public account descriptor, asks a local Friotaíoch Core node to prepare a PSBT, and passes the unsigned and signed PSBTs between the computer and AirGap Vault using animated QR codes.

The app does not ask for or store a recovery phrase or private key. It stores the public descriptor locally and can reconnect to the node when reopened. RPC credentials are encrypted with the operating system's secure storage; they are sent only to the local node at `127.0.0.1:51777`. If secure credential storage is unavailable, the app keeps the login in memory for that session and reports that it could not save auto-connect settings.

## Requirements

- A synced Friotaíoch Core mainnet node on this computer.
- RPC enabled on the node's loopback interface.
- AirGap Vault on a separate phone, with a Bitcoin SegWit account at `m/84'/0'/0'`.
- For QR signing, use AirGap Vault 3.12 or newer; Bitcoin watch-only PSBT support was introduced in 3.12.
- Node.js 20 or newer and pnpm to run or package this source.

The node's genesis block is checked before the app imports an account. The node wallets it creates are descriptor-only with private keys disabled. Each paired public account uses its own named watch-only wallet. The app saves each public descriptor on this computer and can also rediscover the app-created watch-only wallets on reconnect. After pairing an account once, use the wallet selector in the top bar to switch between saved accounts without rescanning their QR codes. Pair a new account by scanning its QR once. Wallet history may take time to scan from the chain's first block.

## Enable local RPC

In the Friotaíoch Core configuration file (`friotaioch.conf`), set a local RPC username and a long random password:

```ini
server=1
rpcuser=frio-desktop
rpcpassword=replace-this-with-a-long-random-value
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
```

Restart Friotaíoch Core. Enter the same credentials in the app's Settings. The app rejects remote RPC hosts and checks the FRIO mainnet genesis hash before using the node.

## Run from source

```text
pnpm install
pnpm start
```

If pnpm reports blocked dependency build scripts, use `pnpm approve-builds` to allow the Electron install script, then run `pnpm install` again. Electron's install script downloads the desktop runtime needed to launch and package the app.

To package a Windows portable app:

```text
pnpm run pack:win
```

The package is written to `release/`. `pnpm run pack:linux` creates a Linux AppImage on a Linux build machine.

## Pair AirGap Vault

1. Connect to the local FRIO node.
2. In AirGap Vault, select its Bitcoin **SegWit** account, choose **Sparrow Wallet**, and show the account QR.
3. Scan that QR in the desktop app. AirGap may export the BIP84 account key as a `zpub`; the app validates it and converts only the extended-key version and checksum to descriptor-standard `xpub` form for `wpkh()`. The public key and chain code remain unchanged. It does not import the Vault's seed.
4. Wait for Friotaíoch Core to finish scanning the account.

The receive page opens on the deterministic first receive address, index `#0`, and lists addresses with their actual BIP84 index. It also shows the Bitcoin `bc1…` equivalent AirGap displays. The conversion preserves the same witness data and recalculates the Bech32 checksum for Bitcoin's `bc` prefix; green highlights FRIO-only prefix/checksum characters, orange highlights Bitcoin-only characters, and the shared address data stays neutral. This is a display aid; the FRIO node still derives and validates the actual FRIO address. Address derivation uses the checksummed descriptor returned by Friotaíoch Core. Balance and activity refresh independently, so an address-derivation problem does not hide wallet funds or history. Balance reads combine Core's trusted `mine` and `watchonly` buckets and cross-check the legacy watch-only `getbalance` result for compatibility. Use **Show next receive address** to move to the next index. Reconnecting with an existing descriptor preserves its current Core range and does not try to shrink it.

Use only a standard BIP84 single-signature SegWit account with the `m/84'/0'/0'` origin. The app accepts P2WPKH descriptors only.

## Send flow

The local node first selects inputs for a watch-only PSBT. The app resolves the first selected input to its FRIO SegWit address, then rebuilds the PSBT with those exact inputs and sets that address as the change destination. This returns change to the same address that received the source funds instead of deriving a fresh internal change address. Reusing an address makes transactions easier to link publicly. The app requests classic BIP174 PSBT v0, places the recipient at output `#0` and change at `#1` when change exists, verifies the recipient script and exact satoshi amount, and adds an explicit `SIGHASH_ALL` field to each input whose sighash is unspecified. The app will not show a signing QR if the node cannot identify a valid source address, returns PSBT v2, or omits the paired account's BIP84 derivation metadata from an input. Before signing, the QR screen includes an AirGap comparison panel with the paired account and its BTC equivalent address, total input amount, recipient operation count, fee, source addresses, every output, and derivation paths when available. The panel displays Bitcoin `bc1…` equivalents beside their FRIO addresses so the details can be compared with AirGap Vault's review. The app shows the recipient, fee, change address, and every output before displaying an animated BC-UR `crypto-psbt` QR. A one-frame QR option is available for small transactions, but both QR modes carry the same PSBT. The signed-QR scanner reports unique fragment progress for animated UR responses and accepts a single-frame base64 PSBT. In AirGap Vault, open the Bitcoin SegWit account and choose **Scan QR**, then keep the signed QR in the camera view until all fragments arrive and the review opens. The app compares the returned transaction's inputs and outputs with the original before offering a separate broadcast action.

## FRIO and AirGap compatibility

Friotaíoch documents classic P2WPKH SegWit v0 addresses (`frio1q…`) alongside its post-quantum address types. The app asks the FRIO node to derive and validate addresses; it never changes a Bitcoin address prefix as a text operation.

For classic SegWit, the signing script and ECDSA rules are compatible with the Bitcoin PSBT flow AirGap Vault supports. The PSBT contains scripts and derivation data rather than a network HRP, so AirGap's Bitcoin screen may display a Bitcoin-formatted equivalent address. Compare the destination and amount shown by this app with what AirGap Vault shows before approving. A FRIO Isolated Module would be useful for native FRIO account labels/address display inside AirGap itself; it is not needed for this desktop app's PSBT coordinator flow.

## Scope and status

- Supports FRIO mainnet, single-signature BIP84 P2WPKH only.
- Requires a local synced Friotaíoch Core node; it does not query a third-party explorer or broadcast through a hosted service.
- Does not support Taproot, multisig, P2QR, testnet, or custom derivation paths.
- Reconnects automatically by default after the first successful connection; turn off **Reconnect automatically** in Settings to disable it.
- This is experimental software. Review and verify the transaction on both screens before broadcasting. AirGap Vault's black-camera failure has not been reproduced locally; use the on-screen compatibility report to help identify PSBT metadata mismatches without sharing the transaction itself.

## References

- [Friotaíoch technical brief](https://www.friotaioch.com/whitepaper.pdf)
- [AirGap: setup Sparrow with AirGap Vault](https://support.airgap.it/guides/sparrow/)
- [AirGap: Isolated Modules](https://support.airgap.it/isolated-module/)
- [BIP 173: Bech32 address format](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki)
