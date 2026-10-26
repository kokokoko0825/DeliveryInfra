import { Navigate, Route, Routes } from 'react-router';
import type { Feature } from '@delivery/shared';
import { getPostLoginPath } from '@delivery/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import LoginPage from './features/auth/LoginPage';
import SignUpPage from './features/auth/SignUpPage';
import PasswordPage from './features/auth/PasswordPage';
import DisplayNamePage from './features/auth/DisplayNamePage';
import { RequireAuth } from './features/auth/RequireAuth';
import { useAuth } from './features/auth/auth-context';
import { AppLayout } from './components/app/AppLayout';
import { LoadingView } from './components/app/StatusView';

// 画面ごとに分割して読み込む（視聴者のスマホで送信・スイッチング用 SDK を読まないため）
const WatchPage = lazy(() => import('./features/viewer/WatchPage'));
const SlidesPage = lazy(() => import('./features/slides/SlidesPage'));
const ArchivesPage = lazy(() => import('./features/archives/ArchivesPage'));
const ArchiveDetailPage = lazy(() => import('./features/archives/ArchiveDetailPage'));
const CameraSendPage = lazy(() => import('./features/sender/CameraSendPage'));
const MicSendPage = lazy(() => import('./features/sender/MicSendPage'));
const SlideSharePage = lazy(() => import('./features/sender/SlideSharePage'));
const SwitcherPage = lazy(() => import('./features/switcher/SwitcherPage'));
const SlidesAdminPage = lazy(() => import('./features/admin/SlidesAdminPage'));
const CommentsAdminPage = lazy(() => import('./features/admin/CommentsAdminPage'));
const UsersAdminPage = lazy(() => import('./features/admin/UsersAdminPage'));
const VenueSpeakerPage = lazy(() => import('./features/venue/VenueSpeakerPage'));

const guarded = (feature: Feature, element: ReactNode) => (
  <RequireAuth feature={feature}><Suspense fallback={<LoadingView />}>{element}</Suspense></RequireAuth>
);

function Home() {
  const { me } = useAuth();
  return <Navigate to={me ? getPostLoginPath(me.role) : '/login'} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/signup" element={<SignUpPage />} />
      <Route path="/password" element={<PasswordPage />} />
      <Route path="/display-name" element={<RequireAuth requireDisplayName={false}><DisplayNamePage /></RequireAuth>} />
      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />
          <Route path="/watch" element={guarded('watch', <WatchPage />)} />
          <Route path="/slides" element={guarded('watch', <SlidesPage />)} />
          <Route path="/archives" element={guarded('archives', <ArchivesPage />)} />
          <Route path="/archives/:id" element={guarded('archives', <ArchiveDetailPage />)} />
          <Route path="/send/camera" element={guarded('cameraSend', <CameraSendPage />)} />
          <Route path="/send/mic" element={guarded('micSend', <MicSendPage />)} />
          <Route path="/venue/mic" element={guarded('micSend', <Navigate to="/send/mic" replace />)} />
          <Route path="/venue/speaker" element={guarded('venueSpeaker', <VenueSpeakerPage />)} />
          <Route path="/send/slide" element={guarded('slideShare', <SlideSharePage />)} />
          <Route path="/admin/switcher" element={guarded('switcher', <SwitcherPage />)} />
          <Route path="/admin/slides" element={guarded('slideManage', <SlidesAdminPage />)} />
          <Route path="/admin/comments" element={guarded('commentModeration', <CommentsAdminPage />)} />
          <Route path="/admin/users" element={guarded('userManage', <UsersAdminPage />)} />
          <Route path="*" element={<section className="py-16 text-center"><h1 className="text-xl font-semibold">ページが見つかりません</h1></section>} />
        </Route>
      </Route>
    </Routes>
  );
}
