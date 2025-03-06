import { Authenticator } from '@unicitylabs/shared/lib/api/Authenticator';

export class Record {
  public constructor(
    public readonly payload: Uint8Array,
    public readonly authenticator: Authenticator,
  ) {}
}
