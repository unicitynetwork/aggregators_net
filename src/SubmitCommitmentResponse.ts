import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { CborEncoder } from '@unicitylabs/commons/lib/cbor/CborEncoder.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { type ISigningService } from '@unicitylabs/commons/lib/signing/ISigningService.js';
import { Signature } from '@unicitylabs/commons/lib/signing/Signature.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

import { Commitment } from './commitment/Commitment.js';

export enum SubmitCommitmentStatus {
  SUCCESS = 'SUCCESS',
  AUTHENTICATOR_VERIFICATION_FAILED = 'AUTHENTICATOR_VERIFICATION_FAILED',
  REQUEST_ID_MISMATCH = 'REQUEST_ID_MISMATCH',
  REQUEST_ID_EXISTS = 'REQUEST_ID_EXISTS',
}

class Request {
  public service: string;
  public method: string;
  public requestId: RequestId;
  public stateHash: DataHash;
  public transactionHash: DataHash;
  public readonly hash: DataHash;

  private constructor(
    service: string,
    method: string,
    requestId: RequestId,
    stateHash: DataHash,
    transactionHash: DataHash,
    hash: DataHash,
  ) {
    this.service = service;
    this.method = method;
    this.requestId = requestId;
    this.stateHash = stateHash;
    this.transactionHash = transactionHash;
    this.hash = hash;
  }

  public static async create(
    service: string,
    method: string,
    requestId: RequestId,
    stateHash: DataHash,
    transactionHash: DataHash,
  ): Promise<Request> {
    const cborBytes = CborEncoder.encodeArray([
      CborEncoder.encodeTextString(service),
      CborEncoder.encodeTextString(method),
      requestId.toCBOR(),
      stateHash.toCBOR(),
      transactionHash.toCBOR(),
    ]);

    const hash = await new DataHasher(HashAlgorithm.SHA256).update(cborBytes).digest();
    return new Request(service, method, requestId, stateHash, transactionHash, hash);
  }

  public toCBOR(): Uint8Array {
    return CborEncoder.encodeArray([
      CborEncoder.encodeTextString(this.service),
      CborEncoder.encodeTextString(this.method),
      this.requestId.toCBOR(),
      this.stateHash.toCBOR(),
      this.transactionHash.toCBOR(),
    ]);
  }

  public toJSON(): IRequestJSON {
    return {
      service: this.service,
      method: this.method,
      requestId: this.requestId.toJSON(),
      stateHash: this.stateHash.toJSON(),
      transactionHash: this.transactionHash.toJSON(),
    };
  }

  public toString(): string {
    return dedent`
      Request
        Service: ${this.service}
        Method: ${this.method}
        Request ID: ${this.requestId.toString()}
        State Hash: ${this.stateHash.toString()}
        Transaction Hash: ${this.transactionHash.toString()}
      `;
  }
}

export interface IRequestJSON {
  service: string;
  method: string;
  requestId: string;
  stateHash: string;
  transactionHash: string;
}

export interface ISubmitCommitmentResponseJSON {
  readonly status: SubmitCommitmentStatus;
  request?: IRequestJSON;
  algorithm?: string;
  publicKey?: string;
  signature?: string;

  readonly exists?: boolean;
}

export class SubmitCommitmentResponse {
  public exists: boolean = false;
  public request: Request | null = null;
  public algorithm: string = '';
  public publicKey: string = '';
  public signature: Signature | null = null;

  public constructor(public readonly status: SubmitCommitmentStatus) {}

  public toJSON(): ISubmitCommitmentResponseJSON {
    const response: ISubmitCommitmentResponseJSON = { status: this.status };
    if (this.request) {
      response.request = this.request.toJSON();
    }
    if (this.algorithm) {
      response.algorithm = this.algorithm;
    }
    if (this.publicKey) {
      response.publicKey = this.publicKey;
    }
    if (this.signature) {
      response.signature = this.signature.toJSON();
    }
    return response;
  }

  public async addReceipt(commitment: Commitment, signingService: ISigningService<Signature>): Promise<void> {
    this.algorithm = signingService.algorithm;
    this.publicKey = HexConverter.encode(signingService.publicKey);

    this.request = await Request.create(
      'aggregator', // TODO use actual service identifier
      'submit_commitment',
      commitment.requestId,
      commitment.authenticator.stateHash,
      commitment.transactionHash,
    );

    this.signature = await signingService.sign(this.request.hash.imprint);
  }

  public toString(): string {
    return dedent`
      Submit Commitment Response
        Status: ${this.status.toString()}
        Request: ${this.request?.toString()}
        Algorithm: ${this.algorithm}
        Public Key: ${this.publicKey}
        Signature: ${this.signature?.toString()}
      `;
  }
}
