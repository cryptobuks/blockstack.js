/* @flow */
import crypto, { randomBytes } from 'crypto'
import bitcoin, { ECPair } from 'bitcoinjs-lib'
import bip39 from 'bip39'
import bip32 from 'bip32'
import type BIP32 from 'bip32'
import { ecPairToHexString } from './utils'
import { encryptMnemonic, decryptMnemonic } from './encryption'

const APPS_NODE_INDEX = 0
const IDENTITY_KEYCHAIN = 888
const BLOCKSTACK_ON_BITCOIN = 0

const BITCOIN_BIP_44_PURPOSE = 44
const BITCOIN_COIN_TYPE = 0
const BITCOIN_ACCOUNT_INDEX = 0

const EXTERNAL_ADDRESS = 'EXTERNAL_ADDRESS'
const CHANGE_ADDRESS = 'CHANGE_ADDRESS'

export type IdentityKeyPair = {
  key: string,
  keyID: string,
  address: string,
  appsNodeKey: string,
  salt: string
}

function hashCode(string) {
  let hash = 0
  if (string.length === 0) return hash
  for (let i = 0; i < string.length; i++) {
    const character = string.charCodeAt(i)
    hash = (hash << 5) - hash + character
    hash &= hash
  }
  return hash & 0x7fffffff
}

function getNodePrivateKey(node: BIP32): string {
  return ecPairToHexString(ECPair.fromPrivateKey(node.privateKey))
}

function getNodePublicKey(node: BIP32): string {
  return node.publicKey.toString('hex')
}

/**
 * The BlockstackWallet class manages the hierarchical derivation
 *  paths for a standard blockstack client wallet. This includes paths
 *  for bitcoin payment address, blockstack identity addresses, blockstack
 *  application specific addresses.
 *  @private
 */
export class BlockstackWallet {
  rootNode: BIP32

  constructor(rootNode: BIP32) {
    this.rootNode = rootNode
  }

  toBase58(): string {
    return this.rootNode.toBase58()
  }

  /**
   * Initialize a blockstack wallet from a seed buffer
   * @param {Buffer} seed - the input seed for initializing the root node
   *  of the hierarchical wallet
   * @return {BlockstackWallet} the constructed wallet
   */
  static fromSeedBuffer(seed: Buffer): BlockstackWallet {
    return new BlockstackWallet(bip32.fromSeed(seed))
  }

  /**
   * Initialize a blockstack wallet from a base58 string
   * @param {string} keychain - the Base58 string used to initialize
   *  the root node of the hierarchical wallet
   * @return {BlockstackWallet} the constructed wallet
   */
  static fromBase58(keychain: string): BlockstackWallet {
    return new BlockstackWallet(bip32.fromBase58(keychain))
  }

  /**
   * Initialize a blockstack wallet from an encrypted phrase & password. Throws
   * if the password is incorrect. Supports all formats of Blockstack phrases.
   * @param {string} data - The encrypted phrase as a hex-encoded string
   * @param {string} password - The plain password
   * @return {Promise<BlockstackWallet>} the constructed wallet
   */
  static fromEncryptedMnemonic(data: string, password: string) {
    return decryptMnemonic(data, password)
      .then((mnemonic) => {
        const seed = bip39.mnemonicToSeed(mnemonic)
        return new BlockstackWallet(bip32.fromSeed(seed))
      })
      .catch((err) => {
        if (err.message && err.message.startsWith('bad header;')) {
          throw new Error('Incorrect password')
        } else {
          throw err
        }
      })
  }

  /**
   * Generate a BIP-39 12 word mnemonic
   * @return {Promise<string>} space-separated 12 word phrase
   */
  static generateMnemonic() {
    return bip39.generateMnemonic(128, randomBytes)
  }

  /**
   * Encrypt a mnemonic phrase with a password
   * @param {string} mnemonic - Raw mnemonic phrase
   * @param {string} password - Password to encrypt mnemonic with
   * @return {Promise<string>} Hex-encoded encrypted mnemonic
   */
  static async encryptMnemonic(mnemonic: string, password: string) {
    const encryptedBuffer = await encryptMnemonic(mnemonic, password)
    return encryptedBuffer.toString('hex')
  }

  getIdentityPrivateKeychain(): BIP32 {
    return this.rootNode
      .deriveHardened(IDENTITY_KEYCHAIN)
      .deriveHardened(BLOCKSTACK_ON_BITCOIN)
  }

  getBitcoinPrivateKeychain(): BIP32 {
    return this.rootNode
      .deriveHardened(BITCOIN_BIP_44_PURPOSE)
      .deriveHardened(BITCOIN_COIN_TYPE)
      .deriveHardened(BITCOIN_ACCOUNT_INDEX)
  }

  getBitcoinNode(addressIndex: number, chainType: string = EXTERNAL_ADDRESS): BIP32 {
    return BlockstackWallet.getNodeFromBitcoinKeychain(
      this.getBitcoinPrivateKeychain().toBase58(),
      addressIndex,
      chainType
    )
  }

  getIdentityAddressNode(identityIndex: number): BIP32 {
    const identityPrivateKeychain = this.getIdentityPrivateKeychain()
    return identityPrivateKeychain.deriveHardened(identityIndex)
  }

  static getAppsNode(identityNode: BIP32): BIP32 {
    return identityNode.deriveHardened(APPS_NODE_INDEX)
  }

  /**
   * Get a salt for use with creating application specific addresses
   * @return {String} the salt
   */
  getIdentitySalt(): string {
    const identityPrivateKeychain = this.getIdentityPrivateKeychain()
    const publicKeyHex = getNodePublicKey(identityPrivateKeychain)
    return crypto.createHash('sha256').update(publicKeyHex).digest('hex')
  }

  /**
   * Get a bitcoin receive address at a given index
   * @param {number} addressIndex - the index of the address
   * @return {String} address
   */
  getBitcoinAddress(addressIndex: number): string {
    return BlockstackWallet.getAddressFromBIP32Node(this.getBitcoinNode(addressIndex))
  }

  /**
   * Get the private key hex-string for a given bitcoin receive address
   * @param {number} addressIndex - the index of the address
   * @return {String} the hex-string. this will be either 64
   * characters long to denote an uncompressed bitcoin address, or 66
   * characters long for a compressed bitcoin address.
   */
  getBitcoinPrivateKey(addressIndex: number): string {
    return getNodePrivateKey(this.getBitcoinNode(addressIndex))
  }

  /**
   * Get the root node for the bitcoin public keychain
   * @return {String} base58-encoding of the public node
   */
  getBitcoinPublicKeychain(): BIP32 {
    return this.getBitcoinPrivateKeychain().neutered()
  }

  /**
   * Get the root node for the identity public keychain
   * @return {String} base58-encoding of the public node
   */
  getIdentityPublicKeychain(): BIP32 {
    return this.getIdentityPrivateKeychain().neutered()
  }

  static getNodeFromBitcoinKeychain(
    keychainBase58: string,
    addressIndex: number,
    chainType: string = EXTERNAL_ADDRESS
  ): BIP32 {
    let chain
    if (chainType === EXTERNAL_ADDRESS) {
      chain = 0
    } else if (chainType === CHANGE_ADDRESS) {
      chain = 1
    } else {
      throw new Error('Invalid chain type')
    }
    const keychain = bip32.fromBase58(keychainBase58)

    return keychain.derive(chain).derive(addressIndex)
  }

  /**
   * Get a bitcoin address given a base-58 encoded bitcoin node
   * (usually called the account node)
   * @param {String} keychainBase58 - base58-encoding of the node
   * @param {number} addressIndex - index of the address to get
   * @param {String} chainType - either 'EXTERNAL_ADDRESS' (for a
   * "receive" address) or 'CHANGE_ADDRESS'
   * @return {String} the address
   */
  static getAddressFromBitcoinKeychain(keychainBase58: string, addressIndex: number,
                                       chainType: string = EXTERNAL_ADDRESS): string {
    return BlockstackWallet.getAddressFromBIP32Node(BlockstackWallet
      .getNodeFromBitcoinKeychain(keychainBase58, addressIndex, chainType))
  }

  /**
   * Get a ECDSA private key hex-string for an application-specific
   *  address.
   * @param {String} appsNodeKey - the base58-encoded private key for
   * applications node (the `appsNodeKey` return in getIdentityKeyPair())
   * @param {String} salt - a string, used to salt the
   * application-specific addresses
   * @param {String} appDomain - the appDomain to generate a key for
   * @return {String} the private key hex-string. this will be a 64
   * character string
   */
  static getLegacyAppPrivateKey(appsNodeKey: string, salt: string, appDomain: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${appDomain}${salt}`)
      .digest('hex')
    const appIndex = hashCode(hash)
    const appNode = bip32.fromBase58(appsNodeKey).deriveHardened(appIndex)
    return getNodePrivateKey(appNode).slice(0, 64)
  }

  static getAddressFromBIP32Node(node: BIP32) {
    return bitcoin.payments.p2pkh({ pubkey: node.publicKey }).address
  }

  /**
   * Get a ECDSA private key hex-string for an application-specific
   *  address.
   * @param {String} appsNodeKey - the base58-encoded private key for
   * applications node (the `appsNodeKey` return in getIdentityKeyPair())
   * @param {String} salt - a string, used to salt the
   * application-specific addresses
   * @param {String} appDomain - the appDomain to generate a key for
   * @return {String} the private key hex-string. this will be a 64
   * character string
   */
  static getAppPrivateKey(appsNodeKey: string, salt: string, appDomain: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${appDomain}${salt}`)
      .digest('hex')
    const appIndexHexes = []
    // note: there's hardcoded numbers here, precisely because I want this
    //   code to be very specific to the derivation paths we expect.
    if (hash.length !== 64) {
      throw new Error(`Unexpected app-domain hash length of ${hash.length}`)
    }
    for (let i = 0; i < 11; i++) { // split the hash into 3-byte chunks
      // because child nodes can only be up to 2^31,
      // and we shouldn't deal in partial bytes.
      appIndexHexes.push(hash.slice(i * 6, i * 6 + 6))
    }
    let appNode = bip32.fromBase58(appsNodeKey)
    appIndexHexes.forEach((hex) => {
      if (hex.length > 6) {
        throw new Error('Invalid hex string length')
      }
      appNode = appNode.deriveHardened(parseInt(hex, 16))
    })
    return getNodePrivateKey(appNode).slice(0, 64)
  }

  /**
   * Get the keypair information for a given identity index. This
   * information is used to obtain the private key for an identity address
   * and derive application specific keys for that address.
   * @param {number} addressIndex - the identity index
   * @param {boolean} alwaysUncompressed - if true, always return a
   *   private-key hex string corresponding to the uncompressed address
   * @return {Object} an IdentityKeyPair type object with keys:
   *   .key {String} - the private key hex-string
   *   .keyID {String} - the public key hex-string
   *   .address {String} - the identity address
   *   .appsNodeKey {String} - the base-58 encoding of the applications node
   *   .salt {String} - the salt used for creating app-specific addresses
   */
  getIdentityKeyPair(addressIndex: number, alwaysUncompressed: ?boolean = false): IdentityKeyPair {
    const identityNode = this.getIdentityAddressNode(addressIndex)

    const address = BlockstackWallet.getAddressFromBIP32Node(identityNode)
    let identityKey = getNodePrivateKey(identityNode)
    if (alwaysUncompressed && identityKey.length === 66) {
      identityKey = identityKey.slice(0, 64)
    }

    const identityKeyID = getNodePublicKey(identityNode)
    const appsNodeKey = BlockstackWallet.getAppsNode(identityNode).toBase58()
    const salt = this.getIdentitySalt()
    const keyPair = {
      key: identityKey,
      keyID: identityKeyID,
      address,
      appsNodeKey,
      salt
    }
    return keyPair
  }
}
