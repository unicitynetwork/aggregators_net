import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';

export enum SubmitCommitmentStatus {
  SUCCESS = 'SUCCESS',
  AUTHENTICATOR_VERIFICATION_FAILED = 'AUTHENTICATOR_VERIFICATION_FAILED',
  REQUEST_ID_MISMATCH = 'REQUEST_ID_MISMATCH',
  REQUEST_ID_EXISTS = 'REQUEST_ID_EXISTS',
}

export interface ISubmitCommitmentResponseDto {
  readonly status: SubmitCommitmentStatus;
}

export class SubmitCommitmentResponse {
  public constructor(public readonly status: SubmitCommitmentStatus) {}

  public toDto(): ISubmitCommitmentResponseDto {
    return { status: this.status };
  }

  public toString(): string {
    return dedent`
      Submit Commitment Response
        Status: ${this.status.toString()}`;
  }
}
