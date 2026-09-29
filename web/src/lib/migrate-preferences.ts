function migratePreferences(storage: Storage): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
    .filter((key): key is string => Boolean(key?.startsWith("loom.")));
  for (const key of keys) {
    const renamed = `citropy.${key.slice(5)}`;
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(renamed) === null)
      storage.setItem(renamed, value);
    storage.removeItem(key);
  }
}

if (typeof localStorage !== "undefined" && typeof localStorage.key === "function")
  migratePreferences(localStorage);
