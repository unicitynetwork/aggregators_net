import { Authenticator } from '@unicitylabs/shared/src/api/Authenticator';

export class Record {
  public constructor(
    public readonly payload: Uint8Array,
    public readonly authenticator: Authenticator,
  ) {}
}
