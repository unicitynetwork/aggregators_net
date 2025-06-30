import { dedent } from '@unicitynetwork/bft-js-sdk/lib/util/StringUtils.js';
import { RequestId } from '@unicitylabs/commons/lib/api/RequestId.js';

export class BlockRecords {
  public constructor(
    public readonly blockNumber: bigint,
    public readonly requestIds: RequestId[],
  ) {}

  public toString(): string {
    return dedent`
      Block Records
        Block Number: ${this.blockNumber}
        Request IDs: \n${this.requestIds.map((requestId) => requestId.toString()).join('\n')}}`;
  }
}
