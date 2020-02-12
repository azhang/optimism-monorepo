/* External Imports */
import { Address } from '@eth-optimism/rollup-core/'
import {
  ZERO_ADDRESS,
  getLogger,
  add0x,
  abi,
  keccak256,
  remove0x,
  hexStrToBuf,
  bufToHexString,
  bufferUtils,
} from '@eth-optimism/core-utils'
import * as ethereumjsAbi from 'ethereumjs-abi'
import { Contract, ContractFactory, Wallet, ethers } from 'ethers'
import { Provider, TransactionReceipt } from 'ethers/providers'
import { Transaction } from 'ethers/utils'

/* Contract Imports */
import * as SimpleStorage from '../build/contracts/SimpleStorage.json'
import { convertInternalLogsToOvmLogs, GAS_LIMIT, CHAIN_ID } from '../src/app'

type Signature = [string, string, string]

export const DEFAULT_ETHNODE_GAS_LIMIT = 9_000_000

const log = getLogger('helpers', true)

/**
 * Helper function for generating initcode based on a contract definition & constructor arguments
 */
export const manuallyDeployOvmContract = async (
  wallet: Wallet,
  provider: Provider,
  executionManager: Contract,
  contractDefinition,
  constructorArguments: any[]
): Promise<Address> => {
  const contract = new ContractFactory(
    contractDefinition.abi,
    contractDefinition.bytecode
  )
  const initCode = new ContractFactory(
    contractDefinition.abi,
    contractDefinition.bytecode
  ).getDeployTransaction(...constructorArguments).data as string
  const result = await executeUnsignedEOACall(
    executionManager,
    wallet,
    undefined,
    initCode
  )
  const convertedLogs = convertInternalLogsToOvmLogs(
    executionManager,
    result.logs
  )
  return convertedLogs.ovmCreatedContractAddress
}

export const executeUnsignedEOACall = async (
  executionManager: Contract,
  wallet: Wallet,
  to: Address,
  data: string
): Promise<TransactionReceipt> => {
  // Verify that the transaction is not accidentally sending to the ZERO_ADDRESS
  if (to === ZERO_ADDRESS) {
    throw new Error('Sending to Zero Address disallowed')
  }

  // Get the `to` field -- NOTE: We have to set `to` to equal ZERO_ADDRESS if this is a contract create
  const ovmTo = to === null || to === undefined ? ZERO_ADDRESS : to

  // Actually make the call
  const tx = await executionManager.executeUnsignedEOACall(
    0,
    0,
    ovmTo,
    data,
    wallet.address
  )
  // Return the parsed transaction values
  return executionManager.provider.waitForTransaction(tx.hash)
}

export const executeEOACall = async (
  executionManager: Contract,
  wallet: Wallet,
  to: Address,
  data: string
): Promise<TransactionReceipt> => {
  // Verify that the transaction is not accidentally sending to the ZERO_ADDRESS
  if (to === ZERO_ADDRESS) {
    throw new Error('Sending to Zero Address disallowed')
  }

  // Get the nonce
  const nonce = await executionManager.getOvmContractNonce(wallet.address)
  // Create the transaction
  const transaction = {
    nonce,
    gasLimit: GAS_LIMIT,
    gasPrice: 0,
    to,
    value: 0,
    data,
    chainId: CHAIN_ID,
  }
  // Sign the transaction
  const signedTransaction = await wallet.sign(transaction)

  // Parse the tx that we just signed to get the signature
  const ovmTx = ethers.utils.parseTransaction(signedTransaction)
  // Get the to field -- NOTE: We have to set `to` to equal ZERO_ADDRESS if this is a contract create
  const ovmTo = to === null || to === undefined ? ZERO_ADDRESS : to

  // Actually make the call
  const tx = await executionManager.executeEOACall(
    0,
    0,
    ovmTx.nonce,
    ovmTo,
    ovmTx.data,
    ovmTx.v,
    ovmTx.r,
    ovmTx.s
  )
  // Return the parsed transaction values
  return executionManager.provider.waitForTransaction(tx.hash)
}

/**
 * Signs a transaction a pads the resulting r and s to 32 bytes
 * @param {ethers.Wallet} wallet
 * @param {ethers.Trasaction} transaction
 */
export const signTransation = async (
  wallet: Wallet,
  transaction: object
): Promise<Signature> => {
  const signedMessage = await wallet.sign(transaction)
  const [v, r, s] = ethers.utils.RLP.decode(signedMessage).slice(-3)
  return [
    v,
    bufToHexString(bufferUtils.padLeft(hexStrToBuf(r), 32)),
    bufToHexString(bufferUtils.padLeft(hexStrToBuf(s), 32)),
  ]
}
/**
 * Creates an unsigned transaction.
 * @param {ethers.Contract} contract
 * @param {String} functionName
 * @param {Array} args
 */
export const getUnsignedTransactionCalldata = (
  contract,
  functionName,
  args
) => {
  return contract.interface.functions[functionName].encode(args)
}

/**
 * Deterministically computes the smart contract address given
 * the account that will deploy the contract (factory contract)
 * the salt as uint256 and the contract bytecode
 * Source: https://github.com/miguelmota/solidity-create2-example
 * Note: Use this function to generate new tests
 */
export const buildCreate2Address = (
  creatorAddress,
  saltHex,
  byteCode
): Address => {
  const preimage: string = `ff${remove0x(creatorAddress)}${remove0x(
    saltHex
  )}${keccak256(byteCode)}`
  return add0x(
    keccak256(preimage)
      .slice(-40)
      .toLowerCase()
  )
}

/**
 * Gets an address string from a bytes32 big-endian Address.
 * @param bytes32Address The 32-byte address string
 * @returns The 0x-prefixed 20-byte address string
 */
export const bytes32AddressToAddress = (bytes32Address: string): Address => {
  return bufToHexString(hexStrToBuf(bytes32Address).slice(12)).toLowerCase()
}

/**
 * Gets a padded big-endian 32-byte address string from an address string.
 * @param addr The 20-byte address string
 * @returns The 0x-prefixed 32-byte address string
 */
export const addressToBytes32Address = (addr: Address): string => {
  return bufToHexString(
    bufferUtils.padLeft(hexStrToBuf(addr), 32)
  ).toLowerCase()
}

/**
 * Converts a number to a 32-byte word hex string
 * @param n the number to convert
 * @returns The 0x-prefixed 32-byte address string
 */
export const numberToHexWord = (n: number): string => {
  return bufToHexString(bufferUtils.padLeft(numberToBuf(n), 32)).toLowerCase()
}

/**
 * Converts a Number to a Buffer of bytes
 * @param n the Number to convert
 * @returns The buffer
 */
export const numberToBuf = (n: number): Buffer => {
  const arr = new ArrayBuffer(4)
  const view = new DataView(arr)
  view.setUint32(0, n, false)
  return Buffer.from(arr)
}

/**
 * Waits for a transaction to complete and returns the result
 * @param n the Number to convert
 * @returns The buffer
 */
export const getTransactionResult = async (
  provider: Provider,
  tx: Transaction,
  returnType: string
): Promise<any[]> => {
  const receipt = await provider.waitForTransaction(tx.hash)
  return abi.decode([returnType], receipt.logs.pop().data)
}