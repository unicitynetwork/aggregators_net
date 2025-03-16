import mongoose, { SchemaType, SchemaTypeOptions } from "mongoose";
import { Binary } from "mongodb";

export const SCHEMA_TYPES = {
    BIGINT_BINARY: "BigIntBinary",
    UINT8_ARRAY: "Uint8Array"
} as const;

function bigIntToUint8Array(bigInt: bigint): Uint8Array {
  let hex = bigInt.toString(16).padStart(64, "0");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function uint8ArrayToBigInt(binary: Binary): bigint {
  return BigInt("0x" + Buffer.from(binary.buffer).toString("hex"));
}

class BigIntBinarySchemaType extends SchemaType {
  static schemaName = SCHEMA_TYPES.BIGINT_BINARY;

  constructor(key: string, options?: SchemaTypeOptions<any>) {
    super(key, options, SCHEMA_TYPES.BIGINT_BINARY);
  }

  cast(val: any) {
    if (typeof val === "bigint") return new Binary(bigIntToUint8Array(val));
    if (val instanceof Binary) return uint8ArrayToBigInt(val);
    throw new Error(`BigIntBinary: Cannot cast ${val} to BigInt`);
  }
}

class Uint8ArraySchemaType extends SchemaType {
  static schemaName = SCHEMA_TYPES.UINT8_ARRAY;

  constructor(key: string, options?: SchemaTypeOptions<any>) {
    super(key, options, SCHEMA_TYPES.UINT8_ARRAY);
  }

  cast(val: any) {
    if (val instanceof Uint8Array) return new Binary(Buffer.from(val));
    if (val instanceof Binary) return new Uint8Array(val.buffer);
    throw new Error(`Uint8ArraySchemaType: Cannot cast ${val}`);
  }
}

(mongoose.Schema.Types as any)[SCHEMA_TYPES.BIGINT_BINARY] = BigIntBinarySchemaType;
(mongoose.Schema.Types as any)[SCHEMA_TYPES.UINT8_ARRAY] = Uint8ArraySchemaType;