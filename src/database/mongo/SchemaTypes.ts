import mongoose, { SchemaType, SchemaTypeOptions } from "mongoose";
import { Binary } from "mongodb";

export const SCHEMA_TYPES = {
    BIGINT_BINARY: "BigIntBinary",
    UINT8_ARRAY: "Uint8Array"
} as const;

function bigIntToBuffer(bigInt: bigint): Buffer {
    const hex = bigInt.toString(16);
    const paddedHex = hex.length % 2 === 0 ? hex : '0' + hex;
    const buf = Buffer.from(paddedHex, "hex");
    return buf;
}

function bufferToBigInt(binary: Binary): bigint {
    return BigInt("0x" + Buffer.from(binary.buffer).toString("hex"));
}

class BigIntBinarySchemaType extends SchemaType {
    static schemaName = SCHEMA_TYPES.BIGINT_BINARY;

    constructor(key: string, options?: SchemaTypeOptions<any>) {
        super(key, options, SCHEMA_TYPES.BIGINT_BINARY);
    }

    cast(val: any) {
        if (typeof val === "bigint") return new Binary(bigIntToBuffer(val));
        if (val instanceof Binary) return bufferToBigInt(val);
        throw new Error(`BigIntBinarySchemaType: Cannot cast ${val}`);
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