export interface ILeadershipStorage {
    tryAcquireLock(lockId: string, serverId: string): Promise<boolean>;
    updateHeartbeat(lockId: string, serverId: string): Promise<boolean>;
    releaseLock(lockId: string, serverId: string): Promise<void>;
    setupTTLIndex(expirySeconds: number): Promise<void>;
}