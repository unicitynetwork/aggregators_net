import { Authenticator } from '@unicitylabs/commons/lib/api/Authenticator.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/commons/lib/hash/DataHash.js';
import { dedent } from '@unicitylabs/commons/lib/util/StringUtils.js';

export class Commitment {
  public constructor(
    public readonly requestId: RequestId,
    public readonly transactionHash: DataHash,
    public readonly authenticator: Authenticator,
  ) {}

  public toString(): string {
    return dedent`
      Commitment
        Request ID: ${this.requestId.toString()}
        Transaction Hash: ${this.transactionHash.toString()}
        ${this.authenticator.toString()}`;
  }
}
