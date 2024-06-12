/** ******************************************************************************
 *  (c) 2019-2024 Zondax AG
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 ******************************************************************************* */
import type Transport from '@ledgerhq/hw-transport'
import BaseApp, { BIP32Path, INSGeneric, processErrorResponse, processResponse } from '@zondax/ledger-js'
import { ByteStream } from '@zondax/ledger-js/dist/byteStream'

import { P1_VALUES, PUBKEYLEN } from './consts'
import { Account, AccountType, ResponseAddress, VaultAccount } from './types'
import { EdSigner, ResponseSign } from './types'

export class SpaceMeshApp extends BaseApp {
  static _INS = {
    GET_VERSION: 0x00 as number,
    GET_ADDR: 0x01 as number,
    SIGN: 0x02 as number,

    GET_ADD_MULTISIG: 0x03 as number,
    GET_ADDR_VESTING: 0x04 as number,
    GET_ADDR_VAULT: 0x05 as number,
  }

  static _params = {
    cla: 0x45,
    ins: { ...SpaceMeshApp._INS } as INSGeneric,
    p1Values: { ONLY_RETRIEVE: 0x00 as 0, SHOW_ADDRESS_IN_DEVICE: 0x01 as 1 },
    chunkSize: 250,
    requiredPathLengths: [5],
  }

  constructor(transport: Transport) {
    super(transport, SpaceMeshApp._params)
    if (!this.transport) {
      throw new Error('Transport has not been defined')
    }
  }

  async getAddressAndPubKey(path: string, showAddrInDevice = false): Promise<ResponseAddress> {
    const bip44PathBuffer = this.serializePath(path)
    const p1 = showAddrInDevice ? P1_VALUES.SHOW_ADDRESS_IN_DEVICE : P1_VALUES.ONLY_RETRIEVE

    try {
      const responseBuffer = await this.transport.send(this.CLA, this.INS.GET_ADDR, p1, 0, bip44PathBuffer)

      const response = processResponse(responseBuffer)

      return {
        pubkey: response.readBytes(PUBKEYLEN),
        address: response.getAvailableBuffer().toString(),
      } as ResponseAddress
    } catch (e) {
      throw processErrorResponse(e)
    }
  }

  async getAddressMultisig(path: string, internalIndex: number, account: Account): Promise<ResponseAddress> {
    if (account.type !== AccountType.Multisig) {
      throw new Error('Invalid account type for multisig address')
    }

    account.checkSanity()

    const bs = new ByteStream()
    bs.appendUint8(internalIndex)
    bs.appendBytes(account.serialize())
    const payload = bs.getCompleteBuffer()

    // [path|internalIndex|approvers|participants|[index|pubkeys]]
    const chunks = this.prepareChunks(path, payload)

    try {
      let response
      for (let i = 0; i < chunks.length; i++) {
        response = await this.signSendChunk(this.INS.GET_ADDR_MULTISIG, i + 1, chunks.length, chunks[i])
      }

      if (!response) {
        throw new Error('Failed to receive response from device')
      }

      return {
        pubkey: response.readBytes(PUBKEYLEN),
        address: response.getAvailableBuffer().toString(),
      } as ResponseAddress
    } catch (e) {
      throw processErrorResponse(e)
    }
  }

  async getAddressVesting(path: string, internalIndex: number, account: Account): Promise<ResponseAddress> {
    if (account.type !== AccountType.Vesting) {
      throw new Error('Invalid account type for vesting address')
    }

    account.checkSanity()

    const bs = new ByteStream()
    bs.appendUint8(internalIndex)
    bs.appendBytes(account.serialize())
    const payload = bs.getCompleteBuffer()

    // [path|internalIndex|approvers|participants|[index|pubkeys]]
    const chunks = this.prepareChunks(path, payload)

    try {
      let response
      for (let i = 0; i < chunks.length; i++) {
        response = await this.signSendChunk(this.INS.GET_ADDR_VESTING, i + 1, chunks.length, chunks[i])
      }

      if (!response) {
        throw new Error('Failed to receive response from device')
      }

      return {
        pubkey: response.readBytes(PUBKEYLEN),
        address: response.getAvailableBuffer().toString(),
      } as ResponseAddress
    } catch (e) {
      throw processErrorResponse(e)
    }
  }

  async getAddressVault(path: string, internalIndex: number, account: VaultAccount, testMode = false): Promise<ResponseAddress> {
    if (!testMode) {
      account.serialize()
    }

    if (account.type !== AccountType.Vault) {
      throw new Error('Invalid account type for vesting address')
    }

    const bs = new ByteStream()
    bs.appendUint8(internalIndex)
    bs.appendBytes(account.serialize())
    const payload = bs.getCompleteBuffer()

    // [path | totalAmount | initialUnlockAmount | vestingStart | vestingEnd | internalIndex | approvers | participants [idx|pubkey] ]
    const chunks = this.prepareChunks(path, payload)

    try {
      let response
      for (let i = 0; i < chunks.length; i++) {
        response = await this.signSendChunk(this.INS.GET_ADDR_VAULT, i + 1, chunks.length, chunks[i])
      }

      if (!response) {
        throw new Error('Failed to receive response from device')
      }

      const pubkey = response.readBytes(PUBKEYLEN)
      const address = response.readBytes(response.length()).toString()

      return {
        pubkey,
        address,
      } as ResponseAddress
    } catch (e) {
      throw processErrorResponse(e)
    }
  }

  async sign(path: BIP32Path, blob: EdSigner): Promise<ResponseSign> {
    const payload = Buffer.concat([blob.prefix, Buffer.from([blob.domain]), blob.message])
    const chunks = this.prepareChunks(path, payload)
    try {
      let signatureResponse = await this.signSendChunk(this.INS.SIGN, 1, chunks.length, chunks[0])

      for (let i = 1; i < chunks.length; i += 1) {
        signatureResponse = await this.signSendChunk(this.INS.SIGN, 1 + i, chunks.length, chunks[i])
      }
      return {
        signature: signatureResponse.readBytes(signatureResponse.length()),
      }
    } catch (e) {
      throw processErrorResponse(e)
    }
  }

  private getInstruction(id: AccountType): number {
    switch (id) {
      case AccountType.Wallet:
        return this.INS.GET_ADDR
      case AccountType.Multisig:
        return this.INS.GET_MULTISIG_ADDR
      case AccountType.Vesting:
        return this.INS.GET_VESTING_ADDR
      case AccountType.Vault:
        return this.INS.GET_VAULT_ADDR
    }
  }
}
