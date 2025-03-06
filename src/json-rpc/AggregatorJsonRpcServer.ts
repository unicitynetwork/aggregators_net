import { Authenticator } from '@unicitylabs/shared/lib/api/Authenticator';
import { DataHasher, HashAlgorithm } from '@unicitylabs/shared/lib/hash/DataHasher';
import { SigningService } from '@unicitylabs/shared/lib/signing/SigningService';
import { SparseMerkleTree } from '@unicitylabs/shared/lib/smt/SparseMerkleTree';
import { BigintConverter } from '@unicitylabs/shared/lib/util/BigintConverter';
import { JSONRPCServer } from 'json-rpc-2.0';

import { Record } from '../Record.js';
import { IStorage } from '../storage/IStorage.js';

interface ILeafData {
  path: bigint;
  value: Uint8Array;
}

export class AggregatorJsonRpcServer extends JSONRPCServer {
  public constructor(
    public readonly records: Map<bigint, Record>,
    public readonly smt: SparseMerkleTree,
    public readonly storage: IStorage,
  ) {
    super();
    this.addMethod('aggregator_submit', () => this.submitStateTransition);
    this.addMethod('aggregator_get_path', this.getInclusionProof);
    this.addMethod('aggregator_get_nodel', this.getNodeletionProof);
  }

  public async submitStateTransition(
    requestId: bigint,
    payload: Uint8Array,
    authenticator: Authenticator,
  ): Promise<any> {
    if (this.records.get(requestId)) {
      if (this.records.get(requestId)!.payload == payload) {
        console.log(`Record with ID ${requestId} already exists.`);
        return { requestId, status: 'success' };
      }
      throw new Error('Request ID already exists with different payload.');
    }

    if (!(await this.verifyAuthenticator(requestId, payload, authenticator))) {
      throw new Error('Invalid authenticator.');
    }

    const record = { authenticator, payload };
    this.records.set(requestId, record);
    await this.storage.put(requestId, record);
    const leaf = await this.recordToLeaf(requestId, record.payload);
    await this.smt.addLeaf(leaf.path, leaf.value);

    console.log(`Request with ID ${requestId} registered, root ${this.smt.rootHash.toString()}`);

    return { requestId, status: 'success' };
  }

  public getInclusionProof(requestId: bigint): Promise<any> {
    throw new Error('Not implemented.');
  }

  public getNodeletionProof(requestId: bigint): Promise<any> {
    throw new Error('Not implemented.');
  }

  private async verifyAuthenticator(
    requestId: bigint,
    payload: Uint8Array,
    authenticator: Authenticator,
  ): Promise<boolean> {
    const publicKey = authenticator.publicKey;
    const expectedRequestId = await new DataHasher(HashAlgorithm.SHA256)
      .update(new Uint8Array([...publicKey, ...authenticator.state]))
      .digest();
    if (BigintConverter.decode(expectedRequestId) !== requestId) {
      return false;
    }
    const payloadHash = await new DataHasher(HashAlgorithm.SHA256).update(payload).digest();
    return await SigningService.verifyWithPublicKey(payloadHash, authenticator.signature, publicKey);
  }

  private async recordToLeaf(requestId: bigint, payload: Uint8Array): Promise<ILeafData> {
    const path = BigInt('0x' + requestId);
    const value = await new DataHasher(HashAlgorithm.SHA256).update(payload).digest();
    return { path, value };
  }
}
