import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';

export enum SubmitStateTransitionStatus {
  SUCCESS = 'SUCCESS',
  AUTHENTICATOR_VERIFICATION_FAILED = 'AUTHENTICATOR_VERIFICATION_FAILED',
  REQUEST_ID_MISMATCH = 'REQUEST_ID_MISMATCH',
  REQUEST_ID_EXISTS = 'REQUEST_ID_EXISTS',
}

export interface ISubmitStateTransitionResponseDto {
  readonly status: SubmitStateTransitionStatus;
}

export class SubmitStateTransitionResponse {
  public constructor(public readonly status: SubmitStateTransitionStatus) {}

  public toDto(): ISubmitStateTransitionResponseDto {
    return { status: this.status };
  }

  public toString(): string {
    return dedent`
      Submit State Transition Response
        Status: ${this.status.toString()}`;
  }
}
