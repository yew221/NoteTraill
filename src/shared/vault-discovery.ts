export type VaultDiscovery = {
  items: Array<{ name: string; absolutePath: string; state: 'available' | 'missing' | 'unreadable'; registered: boolean; locationKey?: string }>;
  warnings: string[];
};
