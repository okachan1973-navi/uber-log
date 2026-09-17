/**
 * UBER_LOG - Supabase Configuration
 * 
 * 責務:
 * - Project URL および Publishable key (sb_publishable_...) の管理
 * - LocalStorageからの動的読み込みおよび設定画面からの更新対応
 * - Secret key / service_role は一切扱わない
 */

const STORAGE_KEY_SUPABASE_URL = 'uber_supabase_url';
const STORAGE_KEY_SUPABASE_ANON_KEY = 'uber_supabase_anon_key';

const SUPABASE_CONFIG = {
  // デフォルト設定値（公開用Project URL & Publishable key）
  defaultUrl: 'https://spvjbdvklkhlqkllcqbn.supabase.co',
  defaultAnonKey: 'sb_publishable_LoxtePtwfQ8fbBePljy9Ew_JtzJkcUo',

  getUrl() {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY_SUPABASE_URL);
      if (stored && stored.trim()) return stored.trim();
    }
    return this.defaultUrl;
  },

  getAnonKey() {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY_SUPABASE_ANON_KEY);
      if (stored && stored.trim()) return stored.trim();
    }
    return this.defaultAnonKey;
  },

  update(newUrl, newKey) {
    if (typeof localStorage !== 'undefined') {
      if (newUrl !== undefined && newUrl !== null) {
        localStorage.setItem(STORAGE_KEY_SUPABASE_URL, newUrl.trim());
      }
      if (newKey !== undefined && newKey !== null) {
        localStorage.setItem(STORAGE_KEY_SUPABASE_ANON_KEY, newKey.trim());
      }
    }
  },

  clear() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY_SUPABASE_URL);
      localStorage.removeItem(STORAGE_KEY_SUPABASE_ANON_KEY);
    }
  },

  isConfigured() {
    const url = this.getUrl();
    const key = this.getAnonKey();
    return Boolean(url && key && url.startsWith('http') && key.length > 10);
  }
};

if (typeof window !== 'undefined') {
  window.SUPABASE_CONFIG = SUPABASE_CONFIG;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPABASE_CONFIG };
}
