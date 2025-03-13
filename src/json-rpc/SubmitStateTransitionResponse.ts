import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils';
import { InclusionProof } from '@unicitylabs/commons/src/api/InclusionProof';
import { SubmitStateTransitionStatus } from '@unicitylabs/commons/src/api/SubmitStateTransitionStatus';

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
