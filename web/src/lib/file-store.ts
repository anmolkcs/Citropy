const STORE = "files";

export function fileStore(databaseName: string) {
  const database = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const transact = async <T,>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).finally(() => db.close());
  };

  return {
    load: (key: string) => transact("readonly", (store) => store.get(key) as IDBRequest<Blob | undefined>),
    save: async (key: string, file: Blob) => { await transact("readwrite", (store) => store.put(file, key)); },
    keys: () => transact("readonly", (store) => store.getAllKeys() as IDBRequest<string[]>),
    remove: async (key: string) => { await transact("readwrite", (store) => store.delete(key)); },
  };
}
