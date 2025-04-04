export interface IBlock {
  index: bigint;
  requestId: bigint;
  chainId: number;
  version: number;
  forkId: number;
  timestamp: bigint;
  rootHash: Uint8Array;
  previousBlockHash: Uint8Array | null;
  txProof: Uint8Array;
  noDeletionProof: Uint8Array | null;
  authenticator: {
    publicKey: Uint8Array;
    algorithm: string;
    signature: Uint8Array;
    stateHash: Uint8Array;
  };
}
