import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';
import { InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';
import { SubmitStateTransitionStatus } from '@unicitylabs/commons/lib/api/SubmitStateTransitionStatus.js';

export class SubmitStateTransitionResponse {
  public constructor(
    public readonly inclusionProof: InclusionProof,
    public readonly status: SubmitStateTransitionStatus,
  ) {}

  public toString(): string {
    return dedent`
      Submit State Transition Response
        Inclusion Proof: ${this.inclusionProof.toString()}
        Status: ${this.status.toString()}`;
  }
}
