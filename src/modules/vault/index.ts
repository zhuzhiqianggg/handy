import type { ModuleMeta } from '@/core/types';

/**
 * 密码存储器（M5）模块元数据。
 *
 * 经 `import.meta.glob`（匹配各模块目录下的 index.ts）自动发现，无需在任何注册表登记。
 * 机密数据的加解密全部收敛在 Rust 侧（`src-tauri/src/commands/vault.rs`）：
 * 主密码经 Argon2id 派生密钥，密钥只存在于后端进程内存，前端仅经 IPC 传明文视图。
 *
 * 安全说明：本模块的视图自带锁定页（未初始化 → 设置主密码 / 已初始化 → 解锁），
 * 并内置 5 分钟无操作自动锁定与复制后 20 秒自动清空剪贴板。
 */
const vaultModule = {
  id: 'vault',
  name: '密码存储器',
  description: '安全存储账号密码与密钥机密',
  icon: 'KeyRound',
  order: 50,
  surface: ['panel'],
  tier: 'free',
  keywords: ['密码', '密码库', '保险库', '密钥', 'vault', 'password', 'mima', 'yaoshi'],
  route: 'vault',
  loadView: () => import('./VaultView'),
} satisfies ModuleMeta;

export default vaultModule;
