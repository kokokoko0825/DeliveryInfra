// apps/web/src/lib/api.ts が参照する Vite の import.meta.env(このパッケージは vite/client の型を持たない)。
interface ImportMetaEnv { readonly VITE_API_BASE_URL?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
