import { useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import { useGrowNode } from './useGrowNode.js';
import OverviewPage from './pages/OverviewPage.jsx';
import AnalysisPage from './pages/AnalysisPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import CameraPage from './pages/CameraPage.jsx';
import HistoryPage from './pages/HistoryPage.jsx';
import NotificationsPage from './pages/NotificationsPage.jsx';
import TeamPage from './pages/TeamPage.jsx';

const PAGES = {
  overview: { title: 'Overview', icon: 'home' },
  analysis: { title: 'Analysis', icon: 'pulse' },
  settings: { title: 'Settings', icon: 'sliders' },
  camera: { title: 'Camera', icon: 'camera' },
  history: { title: 'History', icon: 'chart' },
  notifications: { title: 'Notifications', icon: 'bell' },
  team: { title: 'Team & Build', icon: 'users' },
};

function pageFromHash() {
  const key = (window.location.hash || '').replace('#/', '');
  return PAGES[key] ? key : 'overview';
}

export default function App() {
  const node = useGrowNode();
  const [page, setPage] = useState(pageFromHash);
  const [menuOpen, setMenuOpen] = useState(false);

  const go = (next) => {
    setPage(next);
    window.location.hash = `#/${next}`;
    setMenuOpen(false);
    document.title = `${PAGES[next].title} — GrowNode`;
  };

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    go(pageFromHash());
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Page = {
    overview: OverviewPage,
    analysis: AnalysisPage,
    settings: SettingsPage,
    camera: CameraPage,
    history: HistoryPage,
    notifications: NotificationsPage,
    team: TeamPage,
  }[page];

  return (
    <div className="app">
      <div className={`scrim ${menuOpen ? 'show' : ''}`} onClick={() => setMenuOpen(false)} />
      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-logo"><Icon name="leaf" size={20} /></div>
          <div>
            <div className="brand-name">GrowNode</div>
            <div className="brand-tag">indoor plant monitor</div>
          </div>
        </div>
        <nav className="nav">
          <div className="nav-label">Console</div>
          {['overview', 'analysis', 'settings', 'camera', 'history', 'notifications'].map((key) => (
            <button key={key} className={`nav-btn ${page === key ? 'active' : ''}`} onClick={() => go(key)}>
              <Icon name={PAGES[key].icon} />
              <span>{PAGES[key].title}</span>
              {key === 'notifications' && node.unreadCount > 0 && (
                <span className="nav-badge">{node.unreadCount > 99 ? '99+' : node.unreadCount}</span>
              )}
            </button>
          ))}
          <div className="nav-label">Project</div>
          <button className={`nav-btn ${page === 'team' ? 'active' : ''}`} onClick={() => go('team')}>
            <Icon name="users" />
            <span>Team &amp; Build</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <div className={`conn-pill ${node.isBoardOnline ? '' : 'offline'}`}>
            <span className="conn-dot pulse" />
            {node.isBoardOnline ? 'Connected · syncing' : 'Offline · last seen ' + node.lastSeenDisplay}
          </div>
          <div className="foot-meta">
            IIGS · single plant<br />
            Camera {node.isCameraOnline ? 'online' : 'stale'}
          </div>
        </div>
      </aside>

      <header className="topbar">
        <button className="hamburger" onClick={() => setMenuOpen((o) => !o)} aria-label="Toggle menu">
          <Icon name="menu" size={20} />
        </button>
        <div className="topbar-title">{PAGES[page].title}</div>
        <div className="topbar-sync">{node.isBoardOnline ? `sync ${node.lastSeenDisplay}` : 'offline'}</div>
      </header>

      <main className="content">
        <Page node={node} go={go} />
      </main>

      <div className="toasts">
        {node.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <Icon name={t.tone === 'crit' ? 'alert' : t.tone === 'warn' ? 'bell' : 'check'} size={17} />
            <div>
              <b>{t.title}</b>
              {t.sub ? <span className="t-sub">{t.sub}</span> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}