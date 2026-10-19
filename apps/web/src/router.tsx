import { Link, Navigate, Route, Routes } from 'react-router';
import LoginPage from './features/auth/LoginPage';
import PasswordPage from './features/auth/PasswordPage';
import DisplayNamePage from './features/auth/DisplayNamePage';
import WatchPage from './features/viewer/WatchPage';
import SlidesPage from './features/slides/SlidesPage';
import ArchivesPage from './features/archives/ArchivesPage';
import ArchiveDetailPage from './features/archives/ArchiveDetailPage';
import CameraSendPage from './features/sender/CameraSendPage';
import MicSendPage from './features/sender/MicSendPage';
import SlideSharePage from './features/sender/SlideSharePage';
import SwitcherPage from './features/switcher/SwitcherPage';
import SlidesAdminPage from './features/admin/SlidesAdminPage';
import CommentsAdminPage from './features/admin/CommentsAdminPage';
import UsersAdminPage from './features/admin/UsersAdminPage';

const links = [['/watch', '視聴'], ['/slides', 'スライド'], ['/archives', 'アーカイブ'], ['/admin/switcher', 'スイッチング']] as const;
export function App() {
  return <div className="min-h-screen bg-background text-foreground"><header className="border-b border-border px-6 py-3"><nav className="mx-auto flex max-w-6xl flex-wrap gap-3" aria-label="メインメニュー">{links.map(([to, label]) => <Link className="inline-flex items-center px-3" key={to} to={to}>{label}</Link>)}</nav></header><div className="mx-auto max-w-6xl p-6"><Routes>
    <Route path="/" element={<Navigate to="/watch" replace />} /><Route path="/login" element={<LoginPage />} /><Route path="/password" element={<PasswordPage />} /><Route path="/display-name" element={<DisplayNamePage />} />
    <Route path="/watch" element={<WatchPage />} /><Route path="/slides" element={<SlidesPage />} /><Route path="/archives" element={<ArchivesPage />} /><Route path="/archives/:id" element={<ArchiveDetailPage />} />
    <Route path="/send/camera" element={<CameraSendPage />} /><Route path="/send/mic" element={<MicSendPage />} /><Route path="/send/slide" element={<SlideSharePage />} />
    <Route path="/admin/switcher" element={<SwitcherPage />} /><Route path="/admin/slides" element={<SlidesAdminPage />} /><Route path="/admin/comments" element={<CommentsAdminPage />} /><Route path="/admin/users" element={<UsersAdminPage />} />
    <Route path="*" element={<main><h1>ページが見つかりません</h1></main>} />
  </Routes></div></div>;
}
