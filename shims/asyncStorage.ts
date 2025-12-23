// Web shim for @react-native-async-storage/async-storage
// MetaMask SDK pulls this module in its browser bundle via wagmi connectors.
// On web we can safely back it with localStorage.

type AsyncStorageLike = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

const memory = new Map<string, string>();

function hasLocalStorage() {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

const AsyncStorage: AsyncStorageLike = {
  async getItem(key) {
    if (hasLocalStorage()) return window.localStorage.getItem(key);
    return memory.get(key) ?? null;
  },
  async setItem(key, value) {
    if (hasLocalStorage()) {
      window.localStorage.setItem(key, value);
      return;
    }
    memory.set(key, value);
  },
  async removeItem(key) {
    if (hasLocalStorage()) {
      window.localStorage.removeItem(key);
      return;
    }
    memory.delete(key);
  }
};

export default AsyncStorage;

