/**
 * UBER_LOG - Supabase Client & Auth Manager
 * 
 * 責務:
 * - Supabase JS クライアントの初期化 (CDN: @supabase/supabase-js@2)
 * - Email / Password 方式による1人専用認証
 * - セッションの永続化管理（persistSession: true, autoRefreshToken: true）
 * - ログイン／ログアウト／認証状態監視
 * - Secret key / service_role は一切扱わない（Publishable key のみ使用）
 */

class SupabaseClientManager {
  constructor() {
    this.client = null;
    this.currentUser = null;
    this.session = null;
    this.listeners = [];
    this.initPromise = null;
  }

  // 初期化（ライブラリと設定が揃った時点で実行）
  init() {
    if (typeof window === 'undefined') return false;

    const config = window.SUPABASE_CONFIG;
    if (!config || !config.isConfigured()) {
      return false;
    }

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      return false;
    }

    try {
      const url = config.getUrl();
      const anonKey = config.getAnonKey();

      this.client = window.supabase.createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });

      // 認証状態の変更監視
      this.client.auth.onAuthStateChange((event, session) => {
        this.session = session;
        this.currentUser = session?.user || null;
        this.notifyListeners(event, session);
      });

      // 起動時セッションの復元
      this.initPromise = this.client.auth.getSession().then(({ data, error }) => {
        if (!error && data && data.session) {
          this.session = data.session;
          this.currentUser = data.session.user;
          this.notifyListeners('INITIAL_SESSION', this.session);
          return this.session;
        }
        return null;
      }).catch(err => {
        console.warn('UBER_LOG: Session recovery notice:', err);
        return null;
      });

      return true;
    } catch (err) {
      console.error('UBER_LOG: Failed to initialize Supabase client:', err);
      return false;
    }
  }

  // クライアントが利用可能か
  isReady() {
    if (!this.client) {
      this.init();
    }
    return Boolean(this.client);
  }

  // ログイン済みか
  isLoggedIn() {
    return Boolean(this.currentUser && this.currentUser.id);
  }

  // ログイン中のユーザーメールアドレス
  getUserEmail() {
    return this.currentUser?.email || null;
  }

  // ログイン中のユーザーID（UUID）
  getUserId() {
    return this.currentUser?.id || null;
  }

  // 現在のセッションを取得（Promise）
  async getSession() {
    if (!this.client) {
      this.init();
    }
    if (!this.client) return null;

    if (this.initPromise) {
      await this.initPromise;
    }

    try {
      const { data, error } = await this.client.auth.getSession();
      if (error) {
        console.warn('UBER_LOG: getSession error:', error);
        return null;
      }
      this.session = data.session;
      this.currentUser = data.session?.user || null;
      return this.session;
    } catch (e) {
      console.warn('UBER_LOG: getSession exception:', e);
      return null;
    }
  }

  // Email + Password ログイン
  async login(email, password) {
    if (!this.client) {
      this.init();
    }
    if (!this.client) {
      throw new Error('Supabase接続情報（URL / Publishable key）が設定されていないか、Supabaseライブラリが読み込まれていません。');
    }

    if (!email || !password) {
      throw new Error('メールアドレスとパスワードを入力してください。');
    }

    const { data, error } = await this.client.auth.signInWithPassword({
      email: email.trim(),
      password: password
    });

    if (error) {
      throw new Error(error.message || 'ログインに失敗しました。認証情報を確認してください。');
    }

    this.session = data.session;
    this.currentUser = data.user;
    this.notifyListeners('SIGNED_IN', this.session);
    return data.user;
  }

  // ログアウト（セッション破棄。LocalStorageの実績データは絶対消去しない）
  async logout() {
    if (!this.client) return;

    try {
      await this.client.auth.signOut();
    } catch (e) {
      console.warn('UBER_LOG: signOut error:', e);
    } finally {
      this.session = null;
      this.currentUser = null;
      this.notifyListeners('SIGNED_OUT', null);
    }
  }

  // 認証イベントリスナー登録
  onAuthChange(callback) {
    if (typeof callback === 'function') {
      this.listeners.push(callback);
      // すでにログイン中なら即座に初期通知
      if (this.currentUser) {
        try {
          callback('CURRENT_STATE', this.session, this.currentUser);
        } catch (e) {}
      }
    }
  }

  notifyListeners(event, session) {
    this.listeners.forEach(cb => {
      try {
        cb(event, session, this.currentUser);
      } catch (e) {
        console.error('UBER_LOG: Auth listener callback error:', e);
      }
    });
  }
}

const supabaseManager = new SupabaseClientManager();

if (typeof window !== 'undefined') {
  window.supabaseManager = supabaseManager;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SupabaseClientManager, supabaseManager };
}
