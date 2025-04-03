import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';
import { IInclusionProofDto, InclusionProof } from '@unicitylabs/commons/lib/api/InclusionProof.js';

export enum SubmitStateTransitionStatus {
  SUCCESS = 'SUCCESS',
  AUTHENTICATOR_VERIFICATION_FAILED = 'AUTHENTICATOR_VERIFICATION_FAILED',
  REQUEST_ID_EXISTS = 'REQUEST_ID_EXISTS',
}

export interface ISubmitStateTransitionResponseDto {
  readonly inclusionProof: IInclusionProofDto | null;
  readonly status: SubmitStateTransitionStatus;
}

export class SubmitStateTransitionResponse {
  public constructor(
    public readonly inclusionProof: InclusionProof | null,
    public readonly status: SubmitStateTransitionStatus,
  ) {}

  public toDto(): ISubmitStateTransitionResponseDto {
    return { inclusionProof: this.inclusionProof?.toDto() ?? null, status: this.status };
  }

  public toString(): string {
    return dedent`
      Submit State Transition Response
        Inclusion Proof: ${this.inclusionProof?.toString() ?? 'null'}
        Status: ${this.status.toString()}`;
  }
}
