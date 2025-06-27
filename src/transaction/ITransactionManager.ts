export interface ITransactionManager<TSession> {
  /**
   * Executes the provided operation within a transaction.
   * If the operation succeeds, the transaction is committed. If it fails, the transaction is aborted.
   *
   * @param operation A function that takes a session and performs database operations
   * @returns The result of the operation
   * @throws If the operation fails, the transaction is aborted and the error is rethrown
   */
  withTransaction<T>(operation: (session: TSession) => Promise<T>): Promise<T>;
}
