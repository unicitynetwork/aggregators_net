import { dedent } from '@alphabill/alphabill-js-sdk/lib/util/StringUtils.js';
import { HexConverter } from '@unicitylabs/commons/lib/util/HexConverter.js';

export class SmtNode {
  public constructor(
    public readonly path: bigint,
    private readonly _value: Uint8Array,
  ) {
    this.path = BigInt(path);
    this._value = new Uint8Array(_value);
  }

  public get value(): Uint8Array {
    return new Uint8Array(this._value);
  }

  public toString(): string {
    return dedent`
      SMT Node
        Path: ${this.path}
        Value: ${HexConverter.encode(this._value)}`;
  }
}
